// @ts-check
'use strict';

const labs = require('../../services/labs');
const roomData = require('../../services/roomData');
const log = require('../../services/log');
const market = require('../../services/market');

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
        // Auto: only products worth more than their reagents on the market.
        const mcfg = ctx.config.market;
        const value = market.valuer(mcfg);
        const worth = (/** @type {string} */ product) => market.profitable(product, value, mcfg.productMargin);
        const p = labs.plan(list, stock(rc.room, list), cfg, prev ? prev.product : null, worth);
        if (!prev || prev.product !== p.product) log.info(`[labs] ${rc.name}: ${p.product ? `${p.reagents && p.reagents.join(' + ')} → ${p.product}` : 'no reaction'}`);
        labs.setCurrent(rc.name, p);
    }
};
