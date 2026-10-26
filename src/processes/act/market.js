// @ts-check
'use strict';

const cache = require('../../services/cache');
const log = require('../../services/log');
const market = require('../../services/market');

/**
 * Auto market (docs/v2/MARKET.md; v1 manager.terminal trySell, plus own sell
 * orders for products nobody is buying). Rules in services/market.
 *
 * Each run (every 50 ticks), for every resource in config.market.sell:
 *   deal   sell the surplus above `keep` into the best buy order whose price
 *          after the energy fee is at least the floor; one deal per room per run
 *   order  keep one sell order (in the room with the largest surplus), priced
 *          just under the cheapest competing seller, never below the floor;
 *          topped up as it sells, re-priced every `orderRefresh` ticks
 * Rooms in CRITICAL and terminals on cooldown or short of energy are skipped.
 * Goods are moved into the terminal by the logistics bands (services/market
 * stockFor, used by sense.logistics).
 */

/** Ticks a price history is reused. */
const HISTORY_TTL = 1000;

/** @param {string} res */
function history(res) {
    const store = cache.store('market.history');
    const e = store[res];
    if (e && Game.time - e.t < HISTORY_TTL) return e.h;
    const h = Game.market.getHistory(/** @type {any} */ (res)) || [];
    store[res] = { t: Game.time, h };
    return h;
}

/** @param {import('../../services/market').MarketConfig} cfg */
function energyValue(cfg) {
    if (typeof cfg.energyValue === 'number') return cfg.energyValue;
    const avg = market.avgPrice(history(RESOURCE_ENERGY), cfg.historyDays);
    return avg !== null ? avg : 1;
}

/** @param {string} res */
function myOrders(res) {
    return Object.values(Game.market.orders || {}).filter(o => o.type === ORDER_SELL && o.resourceType === res &&
        (o.remainingAmount || 0) > 0);
}

/**
 * @param {import('../../contracts/ctx').TickContext} ctx
 * @param {string} res
 * @param {import('../../services/market').SellSpec} spec
 * @param {any[]} rooms
 * @param {Set<string>} used rooms that dealt this run
 */
function sellByDeal(ctx, res, spec, rooms, used) {
    const cfg = /** @type {import('../../services/market').MarketConfig} */ (ctx.config.market);
    const fl = market.floor(spec, market.avgPrice(history(res), cfg.historyDays), cfg.floorFactor);
    if (fl === null) return;
    const ev = energyValue(cfg);
    const mine = new Set(Object.keys(Game.market.orders || {}));
    let orders = null;
    for (const r of rooms) {
        if (used.has(r.name)) continue;
        const t = r.terminal;
        const surplus = market.roomStock(r, res) - spec.keep;
        const inTerminal = t.store[res] || 0;
        const energyAvail = (t.store[RESOURCE_ENERGY] || 0) - cfg.minTerminalEnergy;
        if (surplus <= 0 || inTerminal <= 0 || energyAvail <= 0) continue;
        if (!orders) orders = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: /** @type {any} */ (res) });
        const best = market.bestDeal(orders, {
            amount: Math.min(spec.batch || 5000, surplus, inTerminal), floor: fl, energyValue: ev, energyAvail, mine,
            cost: (n, to) => Game.market.calcTransactionCost(n, r.name, to)
        });
        if (!best) continue;
        const code = Game.market.deal(best.order.id, best.amount, r.name);
        used.add(r.name);
        log.info(`[market] ${r.name} sold ${best.amount} ${res} @ ${best.order.price} to ${best.order.roomName} ` +
            `(after fee ${best.effective.toFixed(3)}, floor ${fl.toFixed(3)}, fee ${best.energyCost} energy) → ${code}`);
        if (code === OK) {
            best.order.remainingAmount = (best.order.remainingAmount || best.order.amount) - best.amount;
        }
    }
}

/**
 * @param {import('../../contracts/ctx').TickContext} ctx
 * @param {string} res
 * @param {import('../../services/market').SellSpec} spec
 * @param {any[]} rooms
 */
function sellByOrder(ctx, res, spec, rooms) {
    const cfg = /** @type {import('../../services/market').MarketConfig} */ (ctx.config.market);
    const avg = market.avgPrice(history(res), cfg.historyDays);
    const fl = market.floor(spec, avg, cfg.floorFactor);
    if (fl === null) return;
    const own = myOrders(res);
    const best = rooms.map(r => ({ r, surplus: market.roomStock(r, res) - spec.keep }))
        .filter(x => x.surplus > 0).sort((a, b) => b.surplus - a.surplus)[0];
    const refresh = cache.store('market.orderRefresh');
    const due = !refresh[res] || Game.time - refresh[res] >= cfg.orderRefresh;
    const price = () => {
        const mineIds = new Set(Object.keys(Game.market.orders || {}));
        const sells = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: /** @type {any} */ (res) })
            .filter(o => !mineIds.has(o.id));
        return market.orderPrice(sells, fl, avg);
    };
    if (own.length === 0) {
        if (!best || (best.r.terminal.store[res] || 0) <= 0) return;
        const amount = Math.min(cfg.orderSize, best.surplus);
        const p = price();
        const code = Game.market.createOrder({ type: ORDER_SELL, resourceType: /** @type {any} */ (res), price: p, totalAmount: amount, roomName: best.r.name });
        refresh[res] = Game.time;
        log.info(`[market] ${best.r.name} new sell order ${amount} ${res} @ ${p} (floor ${fl.toFixed(3)}) → ${code}`);
        return;
    }
    const o = own[0];
    if (best && (o.remainingAmount || 0) < cfg.orderSize / 2 && o.roomName === best.r.name) {
        const add = Math.min(cfg.orderSize - (o.remainingAmount || 0), best.surplus - (o.remainingAmount || 0));
        if (add > 0) {
            const code = Game.market.extendOrder(o.id, add);
            log.info(`[market] ${o.roomName} sell order ${res} +${add} (left ${o.remainingAmount}) → ${code}`);
        }
    }
    if (due) {
        refresh[res] = Game.time;
        const p = price();
        if (Math.abs(p - o.price) > o.price * 0.005) {
            const code = Game.market.changeOrderPrice(o.id, p);
            log.info(`[market] sell order ${res} ${o.price} → ${p} (floor ${fl.toFixed(3)}) → ${code}`);
        }
    }
}

/** @type {import('../../contracts/process').Process} */
module.exports = {
    id: 'act.market',
    phase: 'ACT',
    scope: 'shard',
    tier: 'low',
    priority: 85,
    // getAllOrders on a busy resource costs real CPU: every 50 ticks is plenty
    // (one deal of up to `batch` per room per run).
    every: 50,
    run(ctx) {
        const cfg = /** @type {import('../../services/market').MarketConfig} */ (ctx.config.market);
        if (!cfg || !cfg.enabled || !Game.market) return;
        const rooms = ctx.roomList.filter(rc => rc.kind === 'owned' && rc.room && rc.room.terminal && rc.room.terminal.my &&
            !(rc.policy && rc.policy.state === 'CRITICAL')).map(rc => rc.room);
        const ready = rooms.filter(r => r.terminal.cooldown === 0);
        /** @type {Set<string>} */
        const used = new Set();
        for (const res of Object.keys(cfg.sell || {})) {
            const spec = cfg.sell[res];
            if (!spec) continue; // stopped (market.stop)
            if (spec.mode === 'order') sellByOrder(ctx, res, spec, rooms);
            else sellByDeal(ctx, res, spec, ready, used);
        }
    }
};
