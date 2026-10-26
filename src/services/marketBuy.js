// @ts-check
'use strict';

const labs = require('./labs');
const market = require('./market');

/**
 * Buying rules (docs/v2/MARKET.md "Buying"). Pure. Buying is for a purpose,
 * never speculation:
 *   survival    a minimum stock of important boosts; energy for a room in
 *               trouble when no other room can send any
 *   complement  "I have this in my stockpile; with another reagent I can sell
 *               it better": buy the partner of a mineral we already hold, only
 *               when the product's trade price beats selling what we hold
 *
 * Guards mirror selling: a ceiling instead of a floor (min(maxPrice,
 * ceilingFactor × trade reference), rising at most maxRisePerDay), thin
 * markets never bought from (unless you set a maxPrice), spam and bait
 * listings ignored, a credit reserve that is never spent, a daily cap.
 *
 * @typedef {{enabled: boolean, creditReserve: number, dailyCap: number, ceilingFactor: number,
 *            maxRisePerDay: number, stock: Record<string, number>, maxPrice: Record<string, number>,
 *            emergencyEnergy: number, energyBatch: number,
 *            complement: {enabled: boolean, margin: number, anchorMin: number}}} BuyConfig
 * @typedef {import('./market').Order} Order
 */

/**
 * Highest price we pay before the daily-rise limit, or null: never buy.
 * A thin market (no reference) only with your own maxPrice.
 * @param {number|null} ref @param {number|undefined} maxPrice @param {number} factor
 */
function rawCeiling(ref, maxPrice, factor) {
    const byRef = ref !== null ? factor * ref : null;
    const max = Number.isFinite(maxPrice) ? /** @type {number} */ (maxPrice) : null;
    if (byRef === null) return max;
    return max === null ? byRef : Math.min(byRef, max);
}

/**
 * The ceiling may rise at most `maxRisePerDay` per day from what it was
 * (anchor); falls are taken at once. Mirror of market.limitDrop.
 * @param {number|null} raw @param {{p: number, t: number}|undefined} anchor
 * @param {number} time @param {number} maxRisePerDay
 * @returns {{ceiling: number|null, anchor: {p: number, t: number}|undefined}}
 */
function limitRise(raw, anchor, time, maxRisePerDay) {
    if (raw === null) return { ceiling: null, anchor };
    if (!anchor || raw <= anchor.p) return { ceiling: raw, anchor: { p: raw, t: time } };
    const days = Math.max(0, time - anchor.t) / market.TICKS_PER_DAY;
    const highest = anchor.p * (1 + maxRisePerDay * days);
    if (raw <= highest) return { ceiling: raw, anchor: { p: raw, t: time } };
    return { ceiling: highest, anchor };
}

/**
 * Cheapest sell order to buy from by deal, judged on what it really costs us:
 * price + fee × energyValue / amount (the buyer pays the transfer), ≤ ceiling.
 * @param {Order[]} sells  cleaned sell orders
 * @param {{amount: number, ceiling: number, energyValue: number, energyAvail: number,
 *          cost: (amount: number, fromRoom: string) => number}} o
 * @returns {{order: Order, amount: number, energyCost: number, effective: number}|null}
 */
function bestAsk(sells, o) {
    let best = null;
    for (const order of sells) {
        const left = order.remainingAmount !== undefined ? order.remainingAmount : order.amount;
        if (left <= 0 || order.price > o.ceiling || !order.roomName) continue;
        let amount = Math.min(o.amount, left);
        let energyCost = o.cost(amount, order.roomName);
        if (energyCost > o.energyAvail) {
            amount = Math.floor(amount * o.energyAvail / energyCost);
            if (amount <= 0) continue;
            energyCost = o.cost(amount, order.roomName);
            if (energyCost > o.energyAvail) continue;
        }
        const effective = order.price + (energyCost * o.energyValue) / amount;
        if (effective > o.ceiling) continue;
        if (!best || effective < best.effective) best = { order, amount, energyCost, effective };
    }
    return best;
}

/**
 * Price for our own buy order: just above the depth price of competing buy
 * orders (highest first), never above the ceiling; none: the reference (or
 * the ceiling, if lower).
 * @param {Order[]} buys  cleaned buy orders from others
 * @param {number} size @param {number} ceiling @param {number|null} ref
 */
function buyOrderPrice(buys, size, ceiling, ref) {
    const s = buys.slice().sort((a, b) => b.price - a.price);
    let total = 0;
    let depth = null;
    for (const o of s) {
        total += o.remainingAmount !== undefined ? o.remainingAmount : o.amount;
        depth = o.price;
        if (total >= size) break;
    }
    const target = depth !== null ? depth * (1 + market.UNDERCUT) : (ref !== null ? ref : ceiling);
    return Math.round(Math.min(ceiling, target) * 1000) / 1000;
}

/**
 * Credits we may still spend: above the reserve and within today's cap.
 * @param {number} credits @param {{d: number, s: number}|undefined} ledger
 * @param {number} day @param {BuyConfig} cfg
 */
function budget(credits, ledger, day, cfg) {
    const spentToday = ledger && ledger.d === day ? ledger.s : 0;
    return Math.max(0, Math.min(credits - cfg.creditReserve, cfg.dailyCap - spentToday));
}

/** @param {{d: number, s: number}|undefined} ledger @param {number} day @param {number} credits */
function record(ledger, day, credits) {
    return ledger && ledger.d === day ? { d: day, s: ledger.s + credits } : { d: day, s: credits };
}

/**
 * The partner worth buying for a room's stockpile, or null. For each reaction
 * A + B → P with A held (≥ anchorMin) and B short: P must have a trade price,
 * A too, and P ≥ (A + cost of B) × (1 + margin), i.e. reacting beats selling
 * A as it is. Never more B than the A held to react it with, at most
 * `target`. The best margin per unit wins; one reaction per room.
 * @param {Record<string, number>} have   room stock
 * @param {(r: string) => number|null} value  trade reference per resource
 * @param {(r: string) => number|null} cost   what buying B would cost per unit
 * @param {{margin: number, anchorMin: number}} c
 * @param {number} target  stock of B to aim for (enough for the lab planner)
 * @returns {{anchor: string, partner: string, product: string, amount: number, gain: number}|null}
 */
function complement(have, value, cost, c, target) {
    const n = (/** @type {string} */ r) => have[r] || 0;
    let best = null;
    for (const [x, y, product] of labs.reactions()) {
        for (const [a, b] of [[x, y], [y, x]]) {
            if (n(a) < c.anchorMin || n(b) >= target) continue;
            const p = value(product);
            const va = value(a);
            const cb = cost(b);
            if (p === null || va === null || cb === null) continue;
            if (p < (va + cb) * (1 + c.margin)) continue;
            const amount = Math.min(target - n(b), n(a));
            if (amount <= 0) continue;
            const gain = p - va - cb;
            if (!best || gain > best.gain) best = { anchor: a, partner: b, product, amount, gain };
        }
    }
    return best;
}

module.exports = { rawCeiling, limitRise, bestAsk, buyOrderPrice, budget, record, complement };
