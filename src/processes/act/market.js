// @ts-check
'use strict';

const cache = require('../../services/cache');
const log = require('../../services/log');
const market = require('../../services/market');
const energyExport = require('../../services/energyExport');

/**
 * Auto market (docs/v2/MARKET.md; v1 manager.terminal trySell, plus own sell
 * orders and guards against manipulation). Rules in services/market.
 *
 * Each run (every 50 ticks), for every resource in config.market.sell:
 *   order  keep one sell order (in the room with the largest surplus), priced
 *          just under the depth price of the cleaned order book, never below
 *          the floor; topped up as it sells, re-priced every `orderRefresh`
 *   deal   sell the surplus above `keep` into the best (cleaned) buy order
 *          whose price after the energy fee clears the floor; one per room
 * The floor per room: max(minPrice, floorFactor × trade reference, intrinsic
 * value for compounds), falling at most maxDropPerDay per day
 * (Memory.rooms[room].mk[resource] = {p, t}).
 * Rooms in CRITICAL and terminals on cooldown or short of energy are skipped.
 * Goods are stocked in the terminal by the logistics bands (stockFor).
 */

/** @param {import('../../services/market').MarketConfig} cfg @param {(r: string) => number|null} value */
function energyValue(cfg, value) {
    if (typeof cfg.energyValue === 'number') return cfg.energyValue;
    const v = value(RESOURCE_ENERGY);
    return v !== null ? v : 1;
}

/**
 * Floor for selling `res` from `roomName`, with the daily-drop anchor kept in
 * that room's memory.
 * @param {import('../../services/market').MarketConfig} cfg
 * @param {(r: string) => number|null} value
 * @param {string} res @param {import('../../services/market').SellSpec} spec @param {string} roomName
 */
function floorFor(cfg, value, res, spec, roomName) {
    const ref = value(res);
    const intr = market.intrinsic(res, value);
    const raw = market.rawFloor(spec, ref, intr, cfg.floorFactor);
    const mem = /** @type {any} */ (Memory.rooms[roomName] || (Memory.rooms[roomName] = {}));
    const mk = mem.mk || (mem.mk = {});
    const r = market.limitDrop(raw, mk[res], Game.time, cfg.maxDropPerDay);
    if (r.anchor) mk[res] = r.anchor;
    return { floor: r.floor, ref, intr };
}

/** @param {string} res */
function myOrders(res) {
    return Object.values(Game.market.orders || {}).filter(o => o.type === ORDER_SELL && o.resourceType === res &&
        (o.remainingAmount || 0) > 0);
}

/**
 * @param {import('../../services/market').MarketConfig} cfg
 * @param {(r: string) => number|null} value
 * @param {string} res @param {import('../../services/market').SellSpec} spec
 * @param {any[]} rooms @param {Set<string>} used rooms that dealt this run
 * @param {import('../../services/labs').LabConfig} [labCfg]
 */
function sellByDeal(cfg, value, res, spec, rooms, used, labCfg) {
    const ev = energyValue(cfg, value);
    const mine = new Set(Object.keys(Game.market.orders || {}));
    /** @type {any[]|null} */
    let book = null;
    for (const r of rooms) {
        if (used.has(r.name)) continue;
        const t = r.terminal;
        const surplus = market.roomStock(r, res) - market.sellKeep(spec, res, r.name, labCfg);
        const inTerminal = t.store[res] || 0;
        const energyAvail = (t.store[RESOURCE_ENERGY] || 0) - cfg.minTerminalEnergy;
        if (surplus <= 0 || inTerminal <= 0 || energyAvail <= 0) continue;
        const { floor: fl, ref } = floorFor(cfg, value, res, spec, r.name);
        if (fl === null) continue;
        if (!book) {
            book = market.cleanBook(Game.market.getAllOrders({ type: ORDER_BUY, resourceType: /** @type {any} */ (res) }), ref,
                { bandLow: cfg.bandLow, bandHigh: cfg.bandHigh, minAmount: cfg.minListing, mine });
        }
        const best = market.bestDeal(book, {
            amount: Math.min(spec.batch || 5000, surplus, inTerminal), floor: fl, energyValue: ev, energyAvail, mine,
            cost: (n, to) => Game.market.calcTransactionCost(n, r.name, to)
        });
        if (!best) continue;
        const code = Game.market.deal(best.order.id, best.amount, r.name);
        used.add(r.name);
        log.info(`[market] ${r.name} sold ${best.amount} ${res} @ ${best.order.price} to ${best.order.roomName} ` +
            `(after fee ${best.effective.toFixed(3)}, floor ${fl.toFixed(3)}, fee ${best.energyCost} energy) → ${code}`);
        if (code === OK) best.order.remainingAmount = (best.order.remainingAmount || best.order.amount) - best.amount;
    }
}

/**
 * @param {import('../../services/market').MarketConfig} cfg
 * @param {(r: string) => number|null} value
 * @param {string} res @param {import('../../services/market').SellSpec} spec @param {any[]} rooms
 * @param {import('../../services/labs').LabConfig} [labCfg]
 */
function sellByOrder(cfg, value, res, spec, rooms, labCfg) {
    const own = myOrders(res);
    for (const o of own) {
        const r = rooms.find(r => r.name === o.roomName);
        const keep = market.sellKeep(spec, res, o.roomName, labCfg);
        if (r && keep > spec.keep && (o.remainingAmount || 0) > Math.max(0, market.roomStock(r, res) - keep)) {
            Game.market.cancelOrder(o.id);
            return;
        }
    }
    const best = rooms.map(r => ({ r, surplus: market.roomStock(r, res) - market.sellKeep(spec, res, r.name, labCfg) }))
        .filter(x => x.surplus > 0).sort((a, b) => b.surplus - a.surplus)[0];
    const roomName = own.length ? own[0].roomName : best && best.r.name;
    if (!roomName) return;
    const { floor: fl, ref, intr } = floorFor(cfg, value, res, spec, roomName);
    if (fl === null) return;
    const refresh = cache.store('market.orderRefresh');
    const due = !refresh[res] || Game.time - refresh[res] >= cfg.orderRefresh;
    const price = () => {
        const mine = new Set(Object.keys(Game.market.orders || {}));
        const book = market.cleanBook(Game.market.getAllOrders({ type: ORDER_SELL, resourceType: /** @type {any} */ (res) }), ref, {
            bandLow: cfg.bandLow, bandHigh: cfg.bandHigh, mine,
            minAmount: Math.max(cfg.minListing, Math.floor(cfg.orderSize * 0.1))
        });
        return market.orderPrice(book, cfg.orderSize, fl, ref);
    };
    const why = `floor ${fl.toFixed(3)} = max(min ${spec.minPrice === undefined ? '-' : spec.minPrice}, ` +
        `${cfg.floorFactor}×ref ${ref === null ? 'none' : ref.toFixed(3)}, reagents ${intr === null ? '-' : intr.toFixed(3)})`;
    if (own.length === 0) {
        if (!best || (best.r.terminal.store[res] || 0) <= 0) return;
        const amount = Math.min(cfg.orderSize, best.surplus);
        const p = price();
        const code = Game.market.createOrder({ type: ORDER_SELL, resourceType: /** @type {any} */ (res), price: p, totalAmount: amount, roomName: best.r.name });
        refresh[res] = Game.time;
        log.info(`[market] ${best.r.name} new sell order ${amount} ${res} @ ${p} (${why}) → ${code}`);
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
            log.info(`[market] sell order ${res} ${o.price} → ${p} (${why}) → ${code}`);
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
    // getAllOrders on a busy resource costs real CPU: every 50 ticks is plenty.
    every: 50,
    run(ctx) {
        const cfg = /** @type {import('../../services/market').MarketConfig} */ (ctx.config.market);
        if (!cfg || !Game.market) return;
        const value = market.valuer(cfg);
        if (!cfg.enabled) { energyExport.run(ctx, value); return; }
        const rooms = ctx.roomList.filter(rc => rc.kind === 'owned' && rc.room && rc.room.terminal && rc.room.terminal.my &&
            !(rc.policy && rc.policy.state === 'CRITICAL')).map(rc => rc.room);
        const ready = rooms.filter(r => r.terminal.cooldown === 0);
        /** @type {Set<string>} */
        const used = new Set();
        for (const res of Object.keys(cfg.sell || {})) {
            const spec = cfg.sell[res];
            if (!spec) continue; // stopped (market.stop)
            if (spec.mode === 'order') sellByOrder(cfg, value, res, spec, rooms, ctx.config.labs);
            else sellByDeal(cfg, value, res, spec, ready, used, ctx.config.labs);
        }
        energyExport.run(ctx, value);
    },
    floorFor
};
