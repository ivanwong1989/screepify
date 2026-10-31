// @ts-check
'use strict';

const labs = require('../../services/labs');
const roomData = require('../../services/roomData');
const log = require('../../services/log');
const market = require('../../services/market');
const production = require('../../services/productionMarket');

/**
 * Lab plan per room (P12): layout, reaction and roles (services/labs), kept on
 * heap. Every 100 ticks, so the reaction only changes when reagents run out
 * or the product reaches its cap (services/labs keeps the current one).
 */

/** Room stock per resource: storage + terminal + labs. @param {Room} room @param {any[]} list */
function stock(room, list) {
    /** @type {Record<string, number>} */
    const have = {};
    for (const s of [room.storage, room.terminal, ...list]) {
        if (!s) continue;
        for (const r of Object.keys(s.store)) have[r] = (have[r] || 0) + (s.store[/** @type {ResourceConstant} */ (r)] || 0);
    }
    return have;
}

/** @type {import('../../contracts/process').Process} */
module.exports = {
    id: 'plan.labs',
    phase: 'PLAN',
    scope: 'room',
    kinds: ['owned'],
    tier: 'low',
    priority: 60,
    every: 100,
    // After a VM reset the heap plan is gone: plan at once, not on cadence.
    force(ctx, rc) {
        return !labs.current(rc.name) && roomData.myByType(rc.room, STRUCTURE_LAB).length > 0;
    },
    run(ctx, rc) {
        const cfg = labs.configFor(ctx.config.labs, rc.name);
        const list = roomData.myByType(rc.room, STRUCTURE_LAB);
        if (!cfg.enabled || list.length === 0 || !rc.room.storage) {
            if (labs.current(rc.name)) labs.setCurrent(rc.name, { inputs: [], outputs: [], reagents: null, product: null, roles: {} });
            return;
        }
        const prev = labs.current(rc.name);
        // Auto: stock targets or profitable, executable sales demand.
        const mcfg = ctx.config.market;
        const value = market.valuer(mcfg);
        const have = stock(rc.room, list);
        const decisions = {};
        const worth = (/** @type {string} */ product) => {
            const decision = cfg.production ? production.evaluate(rc.room, product, have, mcfg, cfg.production, value, cfg.productCap) :
                { allowed: market.profitable(product, value, mcfg.productMargin), reason: 'legacy_margin' };
            decisions[product] = decision;
            return decision.allowed;
        };
        // Demand-limited purchases may be smaller than the legacy 10k start.
        // Keep the raw reagent reserve while allowing a qualified minimum batch.
        const recipeCfg = cfg.production && cfg.reaction === 'auto' ? Object.assign({}, cfg, {
            minReagent: Math.min(cfg.minReagent, cfg.keepReagent + cfg.production.minBatch)
        }) : cfg;
        const p = labs.plan(list, have, recipeCfg, prev ? prev.product : null, worth);
        production.record(rc.name, { product: p.product, reason: cfg.reaction !== 'auto' ? 'manual_recipe' : p.product ? decisions[p.product].reason : 'no_qualified_recipe', candidates: decisions });
        if (!prev || prev.product !== p.product) log.info(`[labs] ${rc.name}: ${p.product ? `${p.reagents && p.reagents.join(' + ')} → ${p.product}` : 'no reaction'}`);
        labs.setCurrent(rc.name, p);
    }
};
