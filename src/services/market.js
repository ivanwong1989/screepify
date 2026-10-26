// @ts-check
'use strict';

const cache = require('./cache');
const labs = require('./labs');

/**
 * Market rules (docs/v2/MARKET.md). Port of v1 manager.terminal trySell, plus
 * own sell orders and guards against manipulation. Pure apart from
 * `historyOf`, which reads Game.market through a heap cache.
 *
 * Price, the way a careful human would read the market:
 *   reference  trades, not listings: median of the daily averages over the
 *              long window (one fake day can't move a median); the recent
 *              average counts only above `longShare` × that median. Thin
 *              markets (< `minTrades` trades in the window): no reference.
 *   intrinsic  a compound is worth at least its reagents (products of labs).
 *   floor      max(minPrice, floorFactor × reference, intrinsic), and it may
 *              fall at most `maxDropPerDay` per day from what it was (anchor).
 *   order book listings outside [bandLow, bandHigh] × reference are spam;
 *              tiny ones are bait; one room listing the same price many
 *              times counts once. We price against depth: the level where
 *              enough real volume is listed to fill an order our size.
 *
 * @typedef {{mode: 'deal'|'order', keep: number, batch?: number, minPrice?: number}} SellSpec
 * @typedef {{enabled: boolean, sell: Record<string, SellSpec|null>, floorFactor: number,
 *            energyValue: number|'auto', every?: number, minTerminalEnergy: number,
 *            terminalStock: number, orderSize: number, orderRefresh: number,
 *            historyDays: number, longDays: number, longShare: number, minTrades: number,
 *            bandLow: number, bandHigh: number, minListing: number, maxDropPerDay: number,
 *            productMargin: number}} MarketConfig
 * @typedef {{date: string, avgPrice: number, volume: number, transactions?: number}} HistoryDay
 * @typedef {{id: string, price: number, amount: number, remainingAmount?: number, roomName?: string}} Order
 * @typedef {{ref: number|null, recent: number|null, median: number|null, trades: number, liquid: boolean}} Reference
 */

/** Undercut the depth price by this fraction. */
const UNDERCUT = 0.01;
/** Ticks a price history is reused. */
const HISTORY_TTL = 1000;
/** Game ticks per day, roughly (for the floor's daily drop limit). */
const TICKS_PER_DAY = 20000;

/** @param {string} res @returns {HistoryDay[]} */
function historyOf(res) {
    if (typeof Game === 'undefined' || !Game.market || !Game.market.getHistory) return [];
    const store = cache.store('market.history');
    const e = store[res];
    if (e && Game.time - e.t < HISTORY_TTL) return e.h;
    const h = Game.market.getHistory(/** @type {any} */ (res)) || [];
    store[res] = { t: Game.time, h };
    return h;
}

/** @param {HistoryDay[]} history */
function byDateDesc(history) {
    return (history || []).filter(d => d && d.avgPrice > 0 && d.volume > 0)
        .slice().sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * Volume-weighted average price over the most recent `days` days, or null.
 * @param {HistoryDay[]} history @param {number} days
 */
function avgPrice(history, days) {
    let vol = 0;
    let sum = 0;
    for (const d of byDateDesc(history).slice(0, days)) {
        vol += d.volume;
        sum += d.avgPrice * d.volume;
    }
    return vol > 0 ? sum / vol : null;
}

/** @param {number[]} xs @returns {number|null} */
function median(xs) {
    if (xs.length === 0) return null;
    const s = xs.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Trade-based reference price.
 * @param {HistoryDay[]} history
 * @param {{historyDays: number, longDays: number, longShare: number, minTrades: number}} c
 * @returns {Reference}
 */
function reference(history, c) {
    const days = byDateDesc(history).slice(0, c.longDays);
    const trades = days.reduce((t, d) => t + (d.transactions || 0), 0);
    const med = median(days.map(d => d.avgPrice));
    const recent = avgPrice(history, c.historyDays);
    const liquid = trades >= c.minTrades && med !== null;
    const ref = liquid ? Math.max(recent || 0, c.longShare * /** @type {number} */ (med)) : null;
    return { ref, recent, median: med, trades, liquid };
}

/**
 * Value of a compound from its reagents' references, or null if it isn't a
 * compound or a reagent has no reference.
 * @param {string} res @param {(r: string) => number|null} value
 */
function intrinsic(res, value) {
    const r = labs.reagentsOf(res);
    if (!r) return null;
    const a = value(r[0]);
    const b = value(r[1]);
    return a !== null && b !== null ? a + b : null;
}

/**
 * Lowest price we accept before the daily-drop limit, or null if there's no
 * price to go on: then nothing is sold.
 * @param {SellSpec} spec @param {number|null} ref @param {number|null} intr @param {number} factor
 */
function rawFloor(spec, ref, intr, factor) {
    /** @type {number[]} */
    const parts = [];
    if (Number.isFinite(spec.minPrice)) parts.push(/** @type {number} */ (spec.minPrice));
    if (ref !== null) parts.push(factor * ref);
    if (intr !== null) parts.push(intr);
    return parts.length ? Math.max(...parts) : null;
}

/**
 * Applies the daily-drop limit against the last floor (anchor) and returns
 * the floor and the new anchor. Rises are taken at once.
 * @param {number|null} raw
 * @param {{p: number, t: number}|undefined} anchor
 * @param {number} time @param {number} maxDropPerDay
 * @returns {{floor: number|null, anchor: {p: number, t: number}|undefined}}
 */
function limitDrop(raw, anchor, time, maxDropPerDay) {
    if (raw === null) return { floor: null, anchor };
    if (!anchor || raw >= anchor.p) return { floor: raw, anchor: { p: raw, t: time } };
    const days = Math.max(0, time - anchor.t) / TICKS_PER_DAY;
    const lowest = anchor.p * Math.max(0, 1 - maxDropPerDay * days);
    if (raw >= lowest) return { floor: raw, anchor: { p: raw, t: time } };
    return { floor: lowest, anchor };
}

/** @param {Order} o */
const left = (o) => (o.remainingAmount !== undefined ? o.remainingAmount : o.amount);

/**
 * Order book without spam: inside the sanity band around the reference (when
 * there is one), not tiny, not ours, and one entry per (room, price).
 * @param {Order[]} orders @param {number|null} ref
 * @param {{bandLow: number, bandHigh: number, minAmount: number, mine?: Set<string>}} o
 * @returns {Order[]}
 */
function cleanBook(orders, ref, o) {
    /** @type {Map<string, Order>} */
    const seen = new Map();
    for (const order of orders || []) {
        if (!(left(order) >= o.minAmount)) continue;
        if (o.mine && o.mine.has(order.id)) continue;
        if (ref !== null && (order.price < ref * o.bandLow || order.price > ref * o.bandHigh)) continue;
        const key = `${order.roomName || '?'}:${order.price}`;
        const prev = seen.get(key);
        if (!prev || left(order) > left(prev)) seen.set(key, order);
    }
    return Array.from(seen.values());
}

/**
 * Price at which `size` units are listed in total, cheapest first; with less
 * listed than that, the price of the last listing; null with none.
 * @param {Order[]} sells @param {number} size
 */
function depthPrice(sells, size) {
    const s = sells.slice().sort((a, b) => a.price - b.price);
    let total = 0;
    for (const o of s) {
        total += left(o);
        if (total >= size) return o.price;
    }
    return s.length ? s[s.length - 1].price : null;
}

/**
 * Price for our own sell order: just under the depth price of the cleaned
 * book, never below the floor; with no real competition, max(floor, ref).
 * @param {Order[]} cleanSells @param {number} size @param {number} fl @param {number|null} ref
 */
function orderPrice(cleanSells, size, fl, ref) {
    const d = depthPrice(cleanSells, size);
    const target = d !== null ? d * (1 - UNDERCUT) : Math.max(fl, ref || 0);
    return Math.round(Math.max(fl, target) * 1000) / 1000;
}

/**
 * Best buy order to deal with (pass a cleaned book), judged after the energy
 * fee (v1), or null.
 * @param {Order[]} orders
 * @param {{amount: number, floor: number, energyValue: number, energyAvail: number,
 *          cost: (amount: number, toRoom: string) => number, mine: Set<string>}} o
 * @returns {{order: Order, amount: number, energyCost: number, effective: number}|null}
 */
function bestDeal(orders, o) {
    let best = null;
    for (const order of orders) {
        if (left(order) <= 0 || o.mine.has(order.id) || order.price < o.floor || !order.roomName) continue;
        let amount = Math.min(o.amount, left(order));
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
 * Whether making `product` from its reagents is worth it: the product's
 * reference must beat the reagents' by `margin`. An unpriced (thin) product
 * isn't: there's no telling what it would sell for. With no price for the
 * reagents either (no market data at all), there's nothing to judge by and
 * the reaction is allowed.
 * @param {string} product @param {(r: string) => number|null} value @param {number} margin
 */
function profitable(product, value, margin) {
    const cost = intrinsic(product, value);
    if (cost === null) return true;
    const p = value(product);
    return p !== null && p >= cost * (1 + margin);
}

/**
 * Reference price per resource from the cached histories, for this tick.
 * @param {MarketConfig} cfg
 * @returns {(res: string) => number|null}
 */
function valuer(cfg) {
    /** @type {Record<string, number|null>} */
    const memo = {};
    return (res) => {
        if (!(res in memo)) memo[res] = reference(historyOf(res), cfg).ref;
        return memo[res];
    };
}

/**
 * Terminal stock for selling (rounded to 1000s so it doesn't move with every
 * sale; the logistics bands do the moving).
 * @param {number} surplus @param {number} stock
 */
function terminalStock(surplus, stock) {
    if (surplus <= 0) return 0;
    return Math.min(stock, Math.ceil(surplus / 1000) * 1000);
}

/** Room stock of a resource: storage + terminal. @param {Room} room @param {string} res */
function roomStock(room, res) {
    const r = /** @type {ResourceConstant} */ (res);
    return (room.storage ? room.storage.store[r] || 0 : 0) + (room.terminal ? room.terminal.store[r] || 0 : 0);
}

/**
 * Terminal stock targets a room needs for what it sells: {resource: amount}.
 * @param {Room} room @param {MarketConfig} cfg
 * @returns {Record<string, number>}
 */
function stockFor(room, cfg) {
    /** @type {Record<string, number>} */
    const out = {};
    if (!cfg || !cfg.enabled || !room.terminal) return out;
    for (const res of Object.keys(cfg.sell || {})) {
        const spec = cfg.sell[res];
        if (res === RESOURCE_ENERGY || !spec) continue;
        const n = terminalStock(roomStock(room, res) - spec.keep, cfg.terminalStock);
        if (n > 0) out[res] = n;
    }
    return out;
}

module.exports = {
    historyOf, avgPrice, median, reference, intrinsic, rawFloor, limitDrop, cleanBook, depthPrice,
    orderPrice, bestDeal, profitable, valuer, terminalStock, roomStock, stockFor, UNDERCUT, TICKS_PER_DAY
};
