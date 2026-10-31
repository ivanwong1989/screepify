// @ts-check
'use strict';

const cache = require('./cache');
const market = require('./market');
const allocation = require('./resourceAllocation');
const log = require('./log');

/** @typedef {{enabled: boolean, start: number, stop: number, reserve: number, terminalTarget: number, batch: number}} ExportConfig */

/** @param {string} room */
function own(room) {
    return Object.values(Game.market && Game.market.orders || {}).filter(o => o.type === ORDER_SELL && o.resourceType === RESOURCE_ENERGY && o.roomName === room && (o.remainingAmount || 0) > 0);
}

/**
 * Normalize staged terminal energy against its ordinary target. Hauling from
 * storage into the terminal must not itself turn exporting off (or back on).
 * @param {import('../contracts/ctx').RoomCtx} rc @param {import('../config').Config} config
 */
function plan(rc, config) {
    const cfg = config.market.energyExport;
    const room = rc.room;
    const state = cache.store('energy.export');
    const previous = state[rc.name];
    const tc = config.terminal;
    const normal = tc.rooms && tc.rooms[rc.name] && tc.rooms[rc.name].energy;
    const normalTarget = Number.isFinite(normal) ? normal : tc.energy;
    const storage = room.storage ? room.storage.store[RESOURCE_ENERGY] || 0 : 0;
    const terminal = room.terminal ? room.terminal.store[RESOURCE_ENERGY] || 0 : 0;
    const buffered = storage + terminal - normalTarget;
    const eligible = !!(cfg && cfg.enabled && config.market.enabled && config.market.sell.energy === undefined && room.storage && room.terminal &&
        (!rc.kind || rc.kind === 'owned') && (!rc.policy || rc.policy.state === 'GROW'));
    const stop = cfg ? Math.max(cfg.stop, cfg.reserve, 0) : 0;
    const start = cfg ? Math.max(cfg.start, stop + 1) : 0;
    const wasActive = previous ? previous.active : own(rc.name).length > 0;
    const active = eligible && storage >= cfg.reserve && (wasActive ? buffered > stop : buffered > start);
    const target = active ? Math.max(normalTarget, Math.min(cfg.terminalTarget, normalTarget + Math.max(0, storage - cfg.reserve))) : normalTarget;
    const out = { t: Game.time, active, storage, terminal, buffered, normalTarget, terminalTarget: target,
        reserve: cfg ? cfg.reserve : 0, stop, start, surplus: active ? Math.max(0, Math.floor(buffered - stop)) : 0,
        reason: !eligible ? 'disabled_or_room_protected' : storage < cfg.reserve ? 'hard_reserve' : active ? 'export_surplus' : 'within_reserve_band' };
    state[rc.name] = out;
    return out;
}

/** @param {string} room */
function snapshot(room) { return cache.store('energy.export')[room] || null; }

/**
 * Buyer-initiated orders leave the transfer energy to the buyer. Bound each
 * order to staged surplus above the terminal floor, and preserve credit reserve.
 * @param {import('../contracts/ctx').TickContext} ctx
 * @param {(res: string) => number|null} value
 */
function run(ctx, value) {
    const cfg = ctx.config.market.energyExport;
    if (!cfg || !Game.market || ctx.config.market.sell.energy) return;
    const marketCfg = ctx.config.market;
    const ref = cfg.enabled && marketCfg.enabled ? value(RESOURCE_ENERGY) : null;
    const creditFloor = marketCfg.buy ? marketCfg.buy.creditReserve : 0;
    let feeBudget = Math.max(0, Game.market.credits - creditFloor);
    const canPay = credits => credits <= feeBudget;
    const mine = new Set(Object.keys(Game.market.orders || {}));
    for (const rc of ctx.roomList) {
        const p = plan(rc, ctx.config);
        const activeOrders = own(rc.name);
        const completed = Object.values(Game.market.orders || {}).filter(o => o.type === ORDER_SELL && o.resourceType === RESOURCE_ENERGY && o.roomName === rc.name && o.remainingAmount === 0)
            .sort((a, b) => (b.created || 0) - (a.created || 0)).slice(0, 1);
        const orders = activeOrders.length ? activeOrders : completed;
        const cancel = () => { for (const o of activeOrders) if (Game.market.cancelOrder) Game.market.cancelOrder(o.id); };
        if (!p.active) { cancel(); continue; }
        if (ref === null || rc.room.terminal.cooldown > 0) continue;
        // Other commitments and the fee reserve cannot be advertised twice.
        const ours = orders.reduce((n, o) => n + (o.remainingAmount || 0), 0);
        const other = Math.max(0, allocation.sellCommitment(rc.name, RESOURCE_ENERGY) - ours);
        const amount = Math.floor(Math.min(cfg.batch, p.surplus, Math.max(0, p.terminal - marketCfg.minTerminalEnergy - other)));
        if (amount < 1000) { cancel(); continue; }
        const mem = Memory.rooms[rc.name] || (Memory.rooms[rc.name] = {});
        const mk = /** @type {any} */ (mem).mk || (/** @type {any} */ (mem).mk = {});
        const limited = market.limitDrop(ref * marketCfg.floorFactor, mk.energy, Game.time, marketCfg.maxDropPerDay);
        mk.energy = limited.anchor;
        const floor = limited.floor;
        const book = market.cleanBook(Game.market.getAllOrders({ type: ORDER_SELL, resourceType: RESOURCE_ENERGY }), ref,
            { bandLow: marketCfg.bandLow, bandHigh: marketCfg.bandHigh, minAmount: marketCfg.minListing, mine });
        const price = market.orderPrice(book, amount, floor, ref);
        if (!orders.length) {
            if (canPay(price * amount * 0.05)) {
                const result = Game.market.createOrder({ type: ORDER_SELL, resourceType: RESOURCE_ENERGY, price, totalAmount: amount, roomName: rc.name });
                if (result === OK) feeBudget -= price * amount * 0.05;
                log.info(`[energy] ${rc.name} offer ${amount} surplus @ ${price} → ${result}`);
            }
            continue;
        }
        const o = orders[0];
        if (orders.length > 1 || (o.remainingAmount || 0) > amount) { cancel(); continue; }
        let extensionPrice = o.price;
        const refresh = cache.store('energy.orderRefresh');
        if (refresh[rc.name] === undefined || Game.time - refresh[rc.name] >= marketCfg.orderRefresh) {
            refresh[rc.name] = Game.time;
            const fee = Math.max(0, price - o.price) * (o.remainingAmount || 0) * 0.05;
            if (Math.abs(price - o.price) > o.price * 0.005 && canPay(fee) && Game.market.changeOrderPrice(o.id, price) === OK) {
                feeBudget -= fee;
                extensionPrice = price;
            }
        }
        const add = amount - (o.remainingAmount || 0);
        const fee = extensionPrice * add * 0.05;
        if (add > 0 && canPay(fee) && Game.market.extendOrder(o.id, add) === OK) feeBudget -= fee;
    }
}

module.exports = { plan, run, snapshot };
