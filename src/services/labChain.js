// @ts-check
'use strict';

const cache = require('./cache');
const labs = require('./labs');

/**
 * Boost baseline (docs/v2/LABS_CHAIN.md). Pure. A lab room keeps a reserve of
 * boosts for its own defense/attack (`labs.rooms[room].reserve`, in order of
 * priority). The reserve is never sold or used as a reagent; it is refilled
 * before anything is made for sale.
 *
 * To refill, the planner walks the recipe tree from the first short boost:
 * a reaction runs once both reagents are available (above any reserve) for
 * the amount still needed; a compound reagent that is short is made first
 * (all that is needed, so the labs don't switch back and forth); a base
 * mineral that is short is wanted from the market (services/marketBuy).
 *
 * @typedef {{product: string, reagents: string[], amount: number, target: string}} Step
 * @typedef {{step: Step|null, wants: Record<string, number>, short: Record<string, number>, reason: string}} ChainPlan
 */

/** Smallest run worth setting the labs up for. */
const MIN_RUN = 500;
/** Recursion guard (tier 3 is three levels deep). */
const MAX_DEPTH = 6;

/**
 * Stock not held back by the reserve.
 * @param {Record<string, number>} have @param {Record<string, number>} reserve @param {string} res
 */
function available(have, reserve, res) {
    return Math.max(0, (have[res] || 0) - (reserve[res] || 0));
}

/** What is short of the reserve, in its order. @param {Record<string, number>} have @param {Record<string, number>} reserve */
function shortfall(have, reserve) {
    /** @type {Record<string, number>} */
    const out = {};
    for (const res of Object.keys(reserve || {})) {
        const n = (reserve[res] || 0) - (have[res] || 0);
        if (n > 0) out[res] = n;
    }
    return out;
}

/**
 * The reaction to run to make `n` of `product`, or null; adds short base
 * minerals to `wants`. Reagents count only above their own reserve; what this
 * target will use is taken out of `have` (a working copy) for later targets.
 * @param {string} product @param {number} n @param {Record<string, number>} have
 * @param {Record<string, number>} reserve @param {Record<string, number>} wants @param {number} depth
 * @param {string|null} current  the reaction running now: kept while it can run at all
 * @returns {{product: string, reagents: string[], amount: number}|null}
 */
function make(product, n, have, reserve, wants, depth, current) {
    const r = labs.reagentsOf(product);
    if (!r || depth > MAX_DEPTH) return null;
    const need = n;
    /** @type {{product: string, reagents: string[], amount: number}|null} */
    let deeper = null;
    let ready = true;
    for (const x of r) {
        let a = available(have, reserve, x);
        // The running reaction is kept while both reagents last, so stock in
        // motion (in a hauler, between labs) can't make it switch away and back.
        if (product === current && a >= LAB_REACTION_AMOUNT) a = Math.max(a, need);
        // Counted as used, so the next target can't count it again.
        have[x] = (have[x] || 0) - Math.min(a, need);
        if (a >= need) continue;
        if (labs.reagentsOf(x)) {
            // Make all that is missing first, so the run below isn't split.
            ready = false;
            if (!deeper) deeper = make(x, need - a, have, reserve, wants, depth + 1, current);
        } else {
            wants[x] = (wants[x] || 0) + (need - a);
            if (a < Math.min(MIN_RUN, need)) ready = false;
        }
    }
    if (ready) return { product, reagents: r, amount: n };
    return deeper;
}

/**
 * The next reaction for the reserve, and the base minerals to buy for it.
 * @param {Record<string, number>} have  room stock (storage + terminal + labs)
 * @param {Record<string, number>} reserve  boost → amount, in priority order
 * @param {string|null} [current]  the product the labs are making now
 * @returns {ChainPlan}
 */
function plan(have, reserve, current) {
    /** @type {Record<string, number>} */
    const wants = {};
    const short = shortfall(have, reserve);
    const work = Object.assign({}, have);
    /** @type {Step|null} */
    let step = null;
    for (const target of Object.keys(short)) {
        const s = make(target, short[target], work, reserve, wants, 0, current || null);
        if (s && !step) step = Object.assign({ target }, s);
    }
    const reason = Object.keys(short).length === 0 ? 'reserve_full' : step ? 'reserve_refill' : 'reserve_waiting_for_reagents';
    return { step, wants, short, reason };
}

/** Stock left for anything else (sale reactions, partner buying). @param {Record<string, number>} have @param {Record<string, number>} reserve */
function free(have, reserve) {
    /** @type {Record<string, number>} */
    const out = {};
    for (const r of Object.keys(have)) out[r] = available(have, reserve, r);
    return out;
}

/** Latest plan per room (heap), written by plan.labs, read by act.marketBuy and stats. @param {string} room @param {ChainPlan} p */
function record(room, p) { cache.store('labs.chain')[room] = Object.assign({ t: Game.time }, p); }
/** @param {string} room @returns {(ChainPlan & {t: number})|null} */
function snapshot(room) { return cache.store('labs.chain')[room] || null; }

module.exports = { plan, shortfall, available, free, record, snapshot, MIN_RUN };
