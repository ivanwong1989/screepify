// @ts-check
'use strict';

const log = require('../../services/log');
const roomData = require('../../services/roomData');
const market = require('../../services/market');
const buy = require('../../services/marketBuy');

/**
 * Buying (docs/v2/MARKET.md "Buying"; rules in services/marketBuy). Every 100
 * ticks, within the credit reserve and today's cap (Memory.e.mb):
 *   1. energy for a room under `emergencyEnergy` when no other room has
 *      energy to spare (above its stockpile target): by deal, now
 *   2. boosts below 80% of their minimum stock (`buy.stock`): by deal, now
 *   3. complement: in a room with labs, a buy order for the partner of a
 *      mineral it holds, when the product sells better than the mineral alone
 * Prices never above the ceiling (Memory.e.mc[resource] = rise anchor).
 */

/** @param {any} room */
function stock(room) {
    /** @type {Record<string, number>} */
    const have = {};
    const list = [room.storage, room.terminal, ...roomData.myByType(room, STRUCTURE_LAB)];
    for (const s of list) {
        if (!s) continue;
        for (const r of Object.keys(s.store)) have[r] = (have[r] || 0) + (s.store[/** @type {ResourceConstant} */ (r)] || 0);
    }
    return have;
}

/** @type {import('../../contracts/process').Process & Record<string, any>} */
module.exports = {
    id: 'act.marketBuy',
    phase: 'ACT',
    scope: 'shard',
    tier: 'low',
    priority: 86,
    every: 100,
    stock,
    run(ctx) {
        const mcfg = /** @type {import('../../services/market').MarketConfig} */ (ctx.config.market);
        const cfg = /** @type {import('../../services/marketBuy').BuyConfig} */ (/** @type {any} */ (mcfg).buy);
        if (!cfg || !cfg.enabled || !Game.market) return;
        const value = market.valuer(mcfg);
        const day = Math.floor(Game.time / market.TICKS_PER_DAY);
        const e = /** @type {any} */ (Memory).e || (/** @type {any} */ (Memory).e = {});
        const mc = e.mc || (e.mc = {});
        let left = buy.budget(Game.market.credits, e.mb, day, cfg);
        /** @param {number} credits */
        const spend = (credits) => {
            e.mb = buy.record(e.mb, day, credits);
            left -= credits;
        };
        const mine = new Set(Object.keys(Game.market.orders || {}));
        /** @param {string} res */
        const ceilingFor = (res) => {
            const ref = value(res);
            const r = buy.limitRise(buy.rawCeiling(ref, (cfg.maxPrice || {})[res], cfg.ceilingFactor), mc[res], Game.time, cfg.maxRisePerDay);
            if (r.anchor) mc[res] = r.anchor;
            return { ceiling: r.ceiling, ref };
        };
        /** @param {string} res @param {'sell'|'buy'} type @param {number|null} ref */
        const book = (res, type, ref) => market.cleanBook(Game.market.getAllOrders({ type, resourceType: /** @type {any} */ (res) }), ref, {
            // Cheap listings are bargains, not traps, when buying: only the top is cut.
            bandLow: type === ORDER_SELL ? 0 : mcfg.bandLow, bandHigh: mcfg.bandHigh, minAmount: mcfg.minListing, mine
        });
        const ev = value(RESOURCE_ENERGY) || 1;
        const rooms = ctx.roomList.filter(rc => rc.kind === 'owned' && rc.room && rc.room.terminal && rc.room.terminal.my);

        /** Deal-buy `want` of `res` into `room` now. @param {string} res @param {number} want @param {any} room @param {string} why */
        const buyNow = (res, want, room, why) => {
            const { ceiling, ref } = ceilingFor(res);
            if (ceiling === null || left <= 0 || room.terminal.cooldown > 0) return;
            const amount = Math.min(want, Math.floor(left / ceiling));
            if (amount <= 0) return;
            const best = buy.bestAsk(book(res, ORDER_SELL, ref), {
                amount, ceiling, energyValue: ev, energyAvail: room.terminal.store[RESOURCE_ENERGY] || 0,
                cost: (n, from) => Game.market.calcTransactionCost(n, from, room.name)
            });
            if (!best) return;
            const code = Game.market.deal(best.order.id, best.amount, room.name);
            if (code === OK) spend(best.order.price * best.amount);
            log.info(`[market] ${room.name} bought ${best.amount} ${res} @ ${best.order.price} (with fee ${best.effective.toFixed(3)}, ` +
                `ceiling ${ceiling.toFixed(3)}; ${why}) → ${code}`);
        };

        // 1. Emergency energy, only if nobody can send any.
        const targets = ctx.config.policy.stockpileTargets;
        const spare = rooms.some(rc => {
            const t = targets[String(rc.room.controller ? rc.room.controller.level : 0)] || 0;
            return t > 0 && market.roomStock(rc.room, RESOURCE_ENERGY) > t * (1 + ctx.config.policy.stockpileHysteresis);
        });
        if (!spare) {
            for (const rc of rooms) {
                const have = market.roomStock(rc.room, RESOURCE_ENERGY);
                if (have < cfg.emergencyEnergy) buyNow(RESOURCE_ENERGY, Math.min(cfg.energyBatch, cfg.emergencyEnergy - have), rc.room, `emergency: ${have} energy`);
            }
        }

        // 2. Boosts below 80% of their minimum stock.
        const labRooms = rooms.filter(rc => roomData.myByType(rc.room, STRUCTURE_LAB).length >= 3);
        for (const res of Object.keys(cfg.stock || {})) {
            const min = cfg.stock[res];
            const total = rooms.reduce((t, rc) => t + (stock(rc.room)[res] || 0), 0);
            if (!(min > 0) || total >= min * 0.8) continue;
            const room = (labRooms[0] || rooms[0]);
            if (room) buyNow(res, min - total, room.room, `boost stock ${total}/${min}`);
        }

        // 3. Complements: a partner for what a lab room already holds.
        if (!cfg.complement || !cfg.complement.enabled) return;
        for (const rc of labRooms) {
            const lcfg = require('../../services/labs').configFor(ctx.config.labs, rc.name);
            if (!lcfg.enabled || (lcfg.reaction && lcfg.reaction !== 'auto')) continue;
            if (Object.values(Game.market.orders || {}).some(o => o.type === ORDER_BUY && o.roomName === rc.name && (o.remainingAmount || 0) > 0)) continue;
            /** @type {Record<string, number|null>} */
            const prices = {};
            const cost = (/** @type {string} */ b) => {
                if (!(b in prices)) {
                    const { ceiling, ref } = ceilingFor(b);
                    prices[b] = ceiling === null ? null : buy.buyOrderPrice(book(b, ORDER_BUY, ref), lcfg.minReagent, ceiling, ref);
                }
                return prices[b];
            };
            const target = Math.ceil(lcfg.minReagent * 1.5);
            const plan = buy.complement(stock(rc.room), value, cost, cfg.complement, target);
            if (!plan) continue;
            const price = /** @type {number} */ (cost(plan.partner));
            const amount = Math.min(plan.amount, Math.floor(left / (price * 1.05)));
            if (amount < 1000) continue;
            const code = Game.market.createOrder({ type: ORDER_BUY, resourceType: /** @type {any} */ (plan.partner), price, totalAmount: amount, roomName: rc.name });
            if (code === OK) spend(price * amount * 1.05);
            log.info(`[market] ${rc.name} buy order ${amount} ${plan.partner} @ ${price} to react with ${plan.anchor} it holds → ${plan.product} ` +
                `(${plan.product} ${value(plan.product)} vs ${plan.anchor} ${value(plan.anchor)} + ${price}: +${plan.gain.toFixed(2)}/unit) → ${code}`);
        }
    }
};
