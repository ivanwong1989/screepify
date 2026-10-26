// @ts-check
'use strict';

/**
 * Market rules (port of v1 manager.terminal trySell, plus own sell orders).
 * Pure: prices, orders and stock in, a decision out. act.market does the
 * calls. See docs/v2/MARKET.md.
 *
 * - Floor: never below max(spec.minPrice, floorFactor × recent average price).
 * - Deals (mode 'deal'): sell into buy orders, judged on the effective price,
 *   i.e. after the energy fee: price − fee × energyValue / amount (v1).
 * - Own order (mode 'order', for products nobody is buying): one sell order,
 *   priced just under the cheapest competing sell order, never below floor.
 * - Only the surplus above `keep` (storage + terminal of that room) is sold.
 *
 * @typedef {{mode: 'deal'|'order', keep: number, batch?: number, minPrice?: number}} SellSpec
 * @typedef {{enabled: boolean, sell: Record<string, SellSpec>, floorFactor: number,
 *            energyValue: number|'auto', every?: number, minTerminalEnergy: number,
 *            terminalStock: number, orderSize: number, orderRefresh: number, historyDays: number}} MarketConfig
 * @typedef {{date: string, avgPrice: number, volume: number}} HistoryDay
 * @typedef {{id: string, price: number, amount: number, remainingAmount?: number, roomName?: string}} Order
 */

/** Undercut the cheapest competing sell order by this fraction. */
const UNDERCUT = 0.01;

/**
 * Volume-weighted average price over the most recent `days` days, or null.
 * @param {HistoryDay[]} history
 * @param {number} days
 */
function avgPrice(history, days) {
    const recent = (history || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, days);
    let vol = 0;
    let sum = 0;
    for (const d of recent) {
        if (!(d.volume > 0) || !(d.avgPrice > 0)) continue;
        vol += d.volume;
        sum += d.avgPrice * d.volume;
    }
    return vol > 0 ? sum / vol : null;
}

/**
 * Lowest price we accept, or null if there's no price to go on (no history
 * and no minPrice): then nothing is sold.
 * @param {SellSpec} spec @param {number|null} avg @param {number} factor
 */
function floor(spec, avg, factor) {
    const byHistory = avg !== null ? avg * factor : null;
    const min = Number.isFinite(spec.minPrice) ? /** @type {number} */ (spec.minPrice) : null;
    if (byHistory === null && min === null) return null;
    return Math.max(byHistory || 0, min || 0);
}

/**
 * Best buy order to deal with, or null (v1 trySell, without the bugs of
 * selling below floor after the fee).
 * @param {Order[]} orders         buy orders for the resource
 * @param {{amount: number, floor: number, energyValue: number, energyAvail: number,
 *          cost: (amount: number, toRoom: string) => number, mine: Set<string>}} o
 * @returns {{order: Order, amount: number, energyCost: number, effective: number}|null}
 */
function bestDeal(orders, o) {
    let best = null;
    for (const order of orders) {
        const left = order.remainingAmount !== undefined ? order.remainingAmount : order.amount;
        if (left <= 0 || o.mine.has(order.id) || order.price < o.floor || !order.roomName) continue;
        let amount = Math.min(o.amount, left);
        let energyCost = o.cost(amount, order.roomName);
        if (energyCost > o.energyAvail) {
            amount = Math.floor(amount * o.energyAvail / energyCost);
            if (amount <= 0) continue;
            energyCost = o.cost(amount, order.roomName);
            if (energyCost > o.energyAvail) continue;
        }
        if (amount <= 0) continue;
        const effective = order.price - (energyCost * o.energyValue) / amount;
        if (effective < o.floor) continue;
        if (!best || effective > best.effective) best = { order, amount, energyCost, effective };
    }
    return best;
}

/**
 * Price for our own sell order: just under the cheapest competing sell
 * order, never below floor; with no competition, the higher of floor and the
 * recent average.
 * @param {Order[]} sells   other players' sell orders
 * @param {number} fl
 * @param {number|null} avg
 */
function orderPrice(sells, fl, avg) {
    let low = Infinity;
    for (const s of sells) {
        const left = s.remainingAmount !== undefined ? s.remainingAmount : s.amount;
        if (left > 0 && s.price < low) low = s.price;
    }
    const target = Number.isFinite(low) ? low * (1 - UNDERCUT) : Math.max(fl, avg || 0);
    return Math.round(Math.max(fl, target) * 1000) / 1000;
}

/**
 * Terminal stock for selling: what of a resource should sit in the terminal
 * so deals and our order can be filled (rounded to 1000s so it doesn't move
 * with every sale; the logistics bands do the moving).
 * @param {number} surplus @param {number} stock
 */
function terminalStock(surplus, stock) {
    if (surplus <= 0) return 0;
    return Math.min(stock, Math.ceil(surplus / 1000) * 1000);
}

module.exports = { avgPrice, floor, bestDeal, orderPrice, terminalStock, UNDERCUT };

/**
 * Room stock of a resource: storage + terminal.
 * @param {Room} room @param {string} res
 */
function roomStock(room, res) {
    const r = /** @type {ResourceConstant} */ (res);
    return (room.storage ? room.storage.store[r] || 0 : 0) + (room.terminal ? room.terminal.store[r] || 0 : 0);
}

/**
 * Terminal stock targets a room needs for what it sells, for the logistics
 * bands: {resource: amount}.
 * @param {Room} room @param {MarketConfig} cfg
 * @returns {Record<string, number>}
 */
function stockFor(room, cfg) {
    /** @type {Record<string, number>} */
    const out = {};
    if (!cfg || !cfg.enabled || !room.terminal) return out;
    for (const res of Object.keys(cfg.sell || {})) {
        if (res === RESOURCE_ENERGY || !cfg.sell[res]) continue;
        const n = terminalStock(roomStock(room, res) - cfg.sell[res].keep, cfg.terminalStock);
        if (n > 0) out[res] = n;
    }
    return out;
}

module.exports.roomStock = roomStock;
module.exports.stockFor = stockFor;
