// @ts-check
'use strict';

const cache = require('./cache');

/**
 * Lab rules (P12, port of v1 manager.labs; docs/v2/LOGISTICS.md step L4).
 * Pure: positions, stocks and config in, a plan out. Hauling is not here:
 * the plan gives each lab a role, and the lab bands (services/bands) turn the
 * roles into requests and offers like any other store.
 *
 * Roles:
 *   in     input lab: holds one reagent, filled to `inputTarget`
 *   out    output lab: runs the reaction; product offered above `outputMax`
 *   boost  boost lab (config, v1 `boosts`): holds one boost, filled to `boostTarget`
 *   (none) idle lab: anything in it is offered
 *
 * Reaction: `config.labs.reaction` ('KO', ...) or 'auto'. Auto picks the
 * product whose two reagents the room holds most of (the smaller of the two
 * counts), with both at least `minReagent` and the product below `productCap`.
 * The current reaction is kept while its reagents last (above `keepReagent`)
 * and the product is below its cap, so the plan doesn't flip between two
 * reactions with similar stocks. Auto only picks products worth making
 * (`worth`, the market profit check in plan.labs: the product's trade price
 * beats its reagents' by config.market.productMargin; unpriced products don't).
 *
 * @typedef {{enabled: boolean, reaction: string, inputTarget: number, outputMax: number,
 *            boostTarget: number, minReagent: number, keepReagent: number, productCap: number,
 *            boosts: Record<string, string>, rooms: Record<string, any>}} LabConfig
 * @typedef {{kind: 'in'|'out'|'boost', res: string}} LabRole
 * @typedef {{inputs: string[], outputs: string[], reagents: string[]|null, product: string|null,
 *            roles: Record<string, LabRole>}} LabPlan
 */

/**
 * The current plan per room (heap), written by plan.labs, read by
 * sense.logistics (bands) and act.labs.
 * @param {string} roomName
 * @returns {LabPlan|null}
 */
function current(roomName) {
    const e = cache.store('labs.plan')[roomName];
    return e ? e.plan : null;
}

/** @param {string} roomName @param {LabPlan} p */
function setCurrent(roomName, p) {
    cache.store('labs.plan')[roomName] = { t: Game.time, plan: p };
}

/**
 * Lab config for a room: defaults ← config.labs.rooms[room].
 * @param {LabConfig} cfg @param {string} roomName
 * @returns {LabConfig}
 */
function configFor(cfg, roomName) {
    const o = (cfg.rooms && cfg.rooms[roomName]) || {};
    return Object.assign({}, cfg, o, { boosts: Object.assign({}, cfg.boosts || {}, o.boosts || {}) });
}

/** @param {{pos: {x: number, y: number}}} a @param {{pos: {x: number, y: number}}} b */
function range(a, b) {
    return Math.max(Math.abs(a.pos.x - b.pos.x), Math.abs(a.pos.y - b.pos.y));
}

/**
 * The input pair that the most other labs can react with (within 2 of both),
 * v1 chooseBestReactInputPair. Ties: lower ids first, so the choice is stable.
 * @param {any[]} labs  labs available for reactions (boost labs excluded)
 * @returns {{inputs: string[], outputs: string[]}|null}
 */
function layout(labs) {
    if (labs.length < 3) return null;
    const sorted = labs.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
    let best = null;
    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
            const a = sorted[i];
            const b = sorted[j];
            const outs = sorted.filter(l => l !== a && l !== b && range(l, a) <= 2 && range(l, b) <= 2);
            if (!best || outs.length > best.outputs.length) best = { inputs: [a.id, b.id], outputs: outs.map(l => l.id) };
        }
    }
    return best && best.outputs.length > 0 ? best : null;
}

/** All reactions as [reagentA, reagentB, product], each pair once. @returns {[string, string, string][]} */
function reactions() {
    /** @type {[string, string, string][]} */
    const out = [];
    const table = /** @type {any} */ (REACTIONS);
    for (const a of Object.keys(table)) {
        for (const b of Object.keys(table[a])) if (a < b) out.push([a, b, table[a][b]]);
    }
    return out;
}

/** Reagents for a product, or null. @param {string} product */
function reagentsOf(product) {
    const r = reactions().find(x => x[2] === product);
    return r ? [r[0], r[1]] : null;
}

/**
 * @param {Record<string, number>} have   room stock (storage + terminal + labs)
 * @param {LabConfig} cfg
 * @param {string|null} current            product of the current plan
 * @param {(product: string) => boolean} [worth]  auto only: is making it worth it
 *                                         (market profit check, plan.labs); default yes
 * @returns {{reagents: string[], product: string}|null}
 */
function chooseReaction(have, cfg, current, worth) {
    const ok = worth || (() => true);
    const n = (/** @type {string} */ r) => have[r] || 0;
    if (cfg.reaction && cfg.reaction !== 'auto') {
        const r = reagentsOf(cfg.reaction);
        return r ? { reagents: r, product: cfg.reaction } : null;
    }
    if (current) {
        const r = reagentsOf(current);
        if (r && n(r[0]) >= cfg.keepReagent && n(r[1]) >= cfg.keepReagent && n(current) < cfg.productCap && ok(current)) {
            return { reagents: r, product: current };
        }
    }
    let best = null;
    let bestScore = 0;
    for (const [a, b, p] of reactions()) {
        if (n(a) < cfg.minReagent || n(b) < cfg.minReagent || n(p) >= cfg.productCap || !ok(p)) continue;
        const score = Math.min(n(a), n(b));
        if (score > bestScore || (score === bestScore && best && p < best.product)) {
            bestScore = score;
            best = { reagents: [a, b], product: p };
        }
    }
    return best;
}

/**
 * The plan for a room's labs.
 * @param {any[]} labs                   all my labs in the room
 * @param {Record<string, number>} have
 * @param {LabConfig} cfg
 * @param {string|null} current
 * @param {(product: string) => boolean} [worth]
 * @returns {LabPlan}
 */
function plan(labs, have, cfg, current, worth) {
    /** @type {Record<string, LabRole>} */
    const roles = {};
    const boostIds = new Set();
    for (const res of Object.keys(cfg.boosts || {})) {
        const id = cfg.boosts[res];
        if (labs.some(l => l.id === id)) {
            roles[id] = { kind: 'boost', res };
            boostIds.add(id);
        }
    }
    const lay = layout(labs.filter(l => !boostIds.has(l.id)));
    const r = lay ? chooseReaction(have, cfg, current, worth) : null;
    if (!lay || !r) return { inputs: [], outputs: [], reagents: null, product: null, roles };
    roles[lay.inputs[0]] = { kind: 'in', res: r.reagents[0] };
    roles[lay.inputs[1]] = { kind: 'in', res: r.reagents[1] };
    for (const id of lay.outputs) roles[id] = { kind: 'out', res: r.product };
    return { inputs: lay.inputs, outputs: lay.outputs, reagents: r.reagents, product: r.product, roles };
}

module.exports = { layout, reactions, reagentsOf, chooseReaction, plan, range, current, setCurrent, configFor };
