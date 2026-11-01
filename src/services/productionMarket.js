// @ts-check
'use strict';

const cache = require('./cache');
const market = require('./market');
const allocation = require('./resourceAllocation');

/** @typedef {{margin: number, minBatch: number, batch: number, stock: Record<string, number>}} ProductionConfig */

/** @param {string} res */
function buyBook(res) {
    const store = cache.store('production.books');
    const e = store[res];
    if (e && Game.time - e.t < 50) return e.book;
    if (!Game.market || !Game.market.getAllOrders) return [];
    const book = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: /** @type {any} */ (res) }) || [];
    store[res] = { t: Game.time, book };
    return book;
}

/**
 * Require a configured sales exit AND sufficient executable buy depth after
 * transport energy. History is an anti-manipulation reference, never a bid.
 * @param {Room} room @param {string} product @param {Record<string, number>} have
 * @param {import('./market').MarketConfig} cfg @param {ProductionConfig} production
 * @param {(res: string) => number|null} value @param {number} cap
 * @param {number|null} [inputCost] partner-buy check may use its actual ceiling
 */
function evaluate(room, product, have, cfg, production, value, cap, inputCost) {
    const held = have[product] || 0;
    const stock = Math.min(cap, Math.max(0, production.stock[product] || 0));
    if (held < stock) return { allowed: true, reason: 'stock_target', target: stock, depth: 0 };
    const spec = cfg.sell[product];
    if (!cfg.enabled || !spec || spec.mode !== 'deal') return { allowed: false, reason: 'no_executable_sales_policy', target: stock, depth: 0 };
    const reference = value(product);
    const inputs = inputCost === undefined ? market.intrinsic(product, value) : inputCost;
    if (reference === null || inputs === null) return { allowed: false, reason: 'unpriced_or_thin_market', target: stock, depth: 0 };
    const ev = typeof cfg.energyValue === 'number' ? cfg.energyValue : value(RESOURCE_ENERGY);
    if (ev === null || !Game.market || !Game.market.calcTransactionCost) return { allowed: false, reason: 'no_transport_price', target: stock, depth: 0 };
    const min = Math.max(production.minBatch, cfg.minListing);
    const mine = new Set(Object.keys(Game.market.orders || {}));
    const clean = market.cleanBook(buyBook(product), reference, { bandLow: cfg.bandLow, bandHigh: cfg.bandHigh, minAmount: min, mine });
    const raw = market.rawFloor(spec, reference, market.intrinsic(product, value), cfg.floorFactor);
    const roomMem = /** @type {any} */ (Memory.rooms && Memory.rooms[room.name]);
    const salesFloor = market.limitDrop(raw, roomMem && roomMem.mk && roomMem.mk[product], Game.time, cfg.maxDropPerDay).floor;
    const floor = Math.max(salesFloor || 0, inputs * (1 + production.margin));
    let depth = 0;
    for (const order of clean) {
        if (!order.roomName) continue;
        const amount = Math.min(production.batch, order.remainingAmount === undefined ? order.amount : order.remainingAmount);
        const fee = Game.market.calcTransactionCost(amount, room.name, order.roomName);
        if (amount >= min && order.price - fee * ev / amount >= floor) depth += amount;
    }
    // Already-made stock and advertised sales consume the same demand depth.
    const keep = Math.max(stock, spec.keep);
    const target = Math.min(cap, keep + Math.min(production.batch, depth));
    const outstanding = allocation.sellCommitment(room.name, product);
    const surplus = Math.max(0, held - keep);
    const remaining = depth - Math.max(surplus, outstanding);
    return { allowed: remaining >= min && held < target, reason: remaining >= min && held < target ? 'profitable_buy_depth' : 'no_profitable_buy_depth', target, depth, floor };
}

/** @param {string} room @param {any} state */
function record(room, state) { cache.store('production.status')[room] = Object.assign({ t: Game.time }, state); }
/** @param {string} room */
function snapshot(room) { return cache.store('production.status')[room] || null; }

module.exports = { evaluate, record, snapshot };
