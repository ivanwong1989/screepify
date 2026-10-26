'use strict';

/**
 * Auto market (docs/v2/MARKET.md). Price comes from trades, not listings,
 * with guards against manipulation: spam and bait listings, duplicate lines,
 * wash-traded days, thin markets, sudden drops. Real shard3 history
 * (2026-10-12 … 26) is used where it matters.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createWorld, Store } = require('./helpers/sim');

const ROOT = path.join(__dirname, '..');
function fresh() {
    createWorld({ spawn: [25, 25], sources: [[10, 10]], controller: [40, 40] });
    for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'src'))) delete require.cache[k];
    delete global.__v2heap;
}

const day = (date, avgPrice, volume, transactions) => ({ date, avgPrice, volume, transactions });
/** shard3, 2026-10-12 … 26 (avg, volume, transactions). */
const HIST = {
    KO: [day('2026-10-12', 30.59, 1268, 4), day('2026-10-14', 44.49, 37, 2), day('2026-10-19', 42.42, 252, 3),
        day('2026-10-22', 35.54, 119, 1), day('2026-10-23', 34.87, 51, 1)],
    O: [[29.38, 907], [23.61, 1884], [24.1, 3046], [23.38, 2845], [23.68, 2168], [27.03, 2508], [24.33, 2784],
        [21.92, 2498], [20.78, 2232], [17.83, 1822], [13.75, 1332], [15.9, 1761], [17.32, 2296], [14.22, 1834], [18.15, 1168]]
        .map(([p, n], i) => day(`2026-10-${12 + i}`, p, n * 1300, n)),
    K: [[17.28, 637], [18.23, 1453], [17.31, 1584], [15.29, 1199], [16.01, 1066], [13.26, 1297], [15.18, 1537],
        [17.47, 1165], [16.48, 1183], [13.43, 1186], [11.77, 954], [13.86, 1129], [16.63, 1208], [14.62, 1157], [14.26, 644]]
        .map(([p, n], i) => day(`2026-10-${12 + i}`, p, n * 1100, n)),
    energy: [day('2026-10-25', 17, 1e8, 9000), day('2026-10-26', 17, 1e8, 9000)]
};
const CFG = () => require('../src/config').get().market;

test('reference: trades not listings; median of days; thin markets get no price', () => {
    fresh();
    const m = require('../src/services/market');
    const o = m.reference(HIST.O, CFG());
    // Window: the 14 most recent days (10-13 … 26).
    assert.ok(o.liquid && Math.abs(o.median - 21.35) < 0.01, `O median ${o.median}`);
    assert.ok(Math.abs(o.ref - 0.85 * 21.35) < 0.01, `O ref ${o.ref}: recent (~16.5) is below 85% of the median, so the median rules`);
    const k = m.reference(HIST.K, CFG());
    assert.ok(k.liquid && k.ref > 14 && k.ref < 16, `K ref ${k.ref}`);
    const ko = m.reference(HIST.KO, CFG());
    assert.equal(ko.trades, 11);
    assert.equal(ko.liquid, false, 'KO: 11 trades in 14 days is not a market price');
    assert.equal(ko.ref, null);
});

test('wash trades: one fake day at an absurd price barely moves the reference', () => {
    fresh();
    const m = require('../src/services/market');
    const base = m.reference(HIST.O, CFG()).ref;
    const dumped = HIST.O.slice(0, -1).concat([day('2026-10-26', 0.5, 9e6, 3000)]);
    const pumped = HIST.O.slice(0, -1).concat([day('2026-10-26', 500, 9e6, 3000)]);
    const d = m.reference(dumped, CFG()).ref;
    const p = m.reference(pumped, CFG()).ref;
    assert.ok(d >= base * 0.95, `a dumped day: ${base.toFixed(2)} → ${d.toFixed(2)}`);
    assert.ok(p !== null && p > base, 'a pumped day may raise the recent average (only ever makes us ask more)');
    // A median holds until more than half the window is fake: 7 of 14 days
    // only move it halfway; 8 of 14 (over a week of sustained dumping) do.
    const fake = (n) => HIST.O.slice(0, -n).concat(Array.from({ length: n }, (_, i) => day(`2026-10-${27 - n + i}`, 1, 9e6, 3000)));
    assert.ok(m.reference(fake(7), CFG()).ref > base * 0.5, '7 days: still above half');
    assert.ok(m.reference(fake(8), CFG()).ref < base * 0.1, '8 days: moved');
});

test('floor: drops at most 5% per day; rises at once', () => {
    fresh();
    const m = require('../src/services/market');
    const T = m.TICKS_PER_DAY;
    let r = m.limitDrop(20, undefined, 0, 0.05);
    assert.deepEqual(r, { floor: 20, anchor: { p: 20, t: 0 } });
    r = m.limitDrop(5, r.anchor, T, 0.05);
    assert.equal(r.floor, 19, 'a crash to 5 a day later: floor only 5% lower');
    assert.deepEqual(r.anchor, { p: 20, t: 0 }, 'anchor kept until the price comes within the limit');
    r = m.limitDrop(5, r.anchor, 10 * T, 0.05);
    assert.equal(r.floor, 10, 'after 10 days of it: 50% lower');
    assert.equal(m.limitDrop(25, { p: 20, t: 0 }, 1, 0.05).floor, 25, 'rises at once');
});

test('intrinsic: a product is never sold below its reagents (KO = K + O)', () => {
    fresh();
    const m = require('../src/services/market');
    const value = (r) => ({ K: 15.2, O: 18.6 }[r] ?? null);
    assert.ok(Math.abs(m.intrinsic('KO', value) - 33.8) < 1e-9);
    assert.equal(m.intrinsic('O', value), null, 'not a compound');
    assert.equal(m.rawFloor({ mode: 'order', keep: 0 }, null, 33.8, 0.9), 33.8, 'thin KO: floor from its reagents');
    assert.equal(m.rawFloor({ mode: 'order', keep: 0 }, null, null, 0.9), null, 'no price at all: not sold');
    assert.equal(m.rawFloor({ mode: 'order', keep: 0, minPrice: 40 }, null, 33.8, 0.9), 40, 'your minimum wins');
});

test('order book: spam lines, bait and duplicates are ignored; we price against depth', () => {
    fresh();
    const m = require('../src/services/market');
    const ref = 18.6;
    const book = [
        // A bot spamming the same absurd price from one room, many lines.
        ...Array.from({ length: 40 }, (_, i) => ({ id: `lo${i}`, price: 0.01, amount: 100000, roomName: 'E1N1' })),
        ...Array.from({ length: 40 }, (_, i) => ({ id: `hi${i}`, price: 999, amount: 100000, roomName: 'E2N2' })),
        // Bait: a tiny order just under everyone.
        { id: 'bait', price: 10, amount: 4, roomName: 'E3N3' },
        // Real sellers; one listed three times at the same price.
        { id: 'a1', price: 17.5, amount: 2000, roomName: 'W10S10' },
        { id: 'a2', price: 17.5, amount: 2000, roomName: 'W10S10' },
        { id: 'a3', price: 17.5, amount: 2000, roomName: 'W10S10' },
        { id: 'b', price: 18.2, amount: 4000, roomName: 'W20S20' },
        { id: 'c', price: 19.0, amount: 10000, roomName: 'W30S30' }
    ];
    const clean = m.cleanBook(book, ref, { bandLow: 0.5, bandHigh: 2, minAmount: 1000 });
    assert.deepEqual(clean.map(o => o.id).sort(), ['a1', 'b', 'c'], '80 spam lines, bait and 2 duplicates gone');
    assert.equal(m.depthPrice(clean, 5000), 18.2, 'depth for 5,000: 2,000 @ 17.5 isn\'t enough, 4,000 more @ 18.2 is');
    assert.equal(m.orderPrice(clean, 5000, 16.0, ref), 18.018, '1% under the depth price');
    assert.equal(m.orderPrice(clean, 5000, 18.5, ref), 18.5, 'never below our floor');
    // Without the guards the top of the book would have been the spam at 0.01.
    assert.equal(m.orderPrice(m.cleanBook(book, ref, { bandLow: 0, bandHigh: Infinity, minAmount: 0 }), 5000, 16.0, ref), 16.0);
});

test('deals: judged after the energy fee; spam buy orders never reached', () => {
    fresh();
    const m = require('../src/services/market');
    const dist = { E39S4: 80, W45S28: 1 };
    const cost = (n, to) => Math.ceil(n * (1 - Math.exp(-dist[to] / 30)));
    const orders = [
        { id: 'far', price: 18.5, amount: 5000, roomName: 'E39S4' },
        { id: 'near', price: 18.0, amount: 5000, roomName: 'W45S28' }
    ];
    const opt = (ev, fl) => ({ amount: 5000, floor: fl, energyValue: ev, energyAvail: 50000, cost, mine: new Set() });
    assert.equal(m.bestDeal(orders, opt(0.1, 16.2)).order.id, 'far', 'cheap energy: the higher price wins (18.41 vs 18.00)');
    assert.equal(m.bestDeal(orders, opt(1, 16.2)).order.id, 'near', 'at 1 credit/energy the near buyer nets more (17.97 vs 17.57)');
    assert.equal(m.bestDeal(orders, opt(17, 16.2)).order.id, 'near', 'at 17: only the near buyer clears the floor (17.44; far 2.68)');
    assert.equal(m.bestDeal(orders, opt(17, 17.5)), null, 'nothing above floor after the fee: no deal');
    const spam = [{ id: 'x', price: 900, amount: 1, roomName: 'W45S28' }].concat(orders);
    const clean = m.cleanBook(spam, 18.6, { bandLow: 0.5, bandHigh: 2, minAmount: 1000 });
    assert.ok(!clean.some(o => o.id === 'x'), 'an absurd 1-unit buy order is not chased');
});

test('labs: only make a product worth more than its reagents', () => {
    fresh();
    const m = require('../src/services/market');
    const value = (r) => ({ K: 15.2, O: 18.6, H: 5, OH: 40 }[r] ?? null);
    assert.equal(m.profitable('KO', value, 0.05), false, 'KO has no trusted price (thin): not made');
    assert.equal(m.profitable('OH', value, 0.05), true, 'OH 40 > (H 5 + O 18.6) × 1.05');
    assert.equal(m.profitable('OH', (r) => ({ H: 15, O: 18.6, OH: 34 }[r] ?? null), 0.05), false, '34 < 33.6 × 1.05');
    assert.equal(m.profitable('KO', () => null, 0.05), true, 'no market data at all (sim, private server): allowed');
    const labs = require('../src/services/labs');
    const lcfg = require('../src/config').get().labs;
    const have = { K: 131000, O: 143000, H: 30000 };
    const worth = (p) => m.profitable(p, value, 0.05);
    assert.deepEqual(labs.chooseReaction(have, lcfg, null, worth), { reagents: ['H', 'O'], product: 'OH' }, 'OH instead of KO');
    assert.equal(labs.chooseReaction(have, lcfg, 'KO', worth).product, 'OH', 'and the current KO is dropped');
    assert.equal(labs.chooseReaction(have, { ...lcfg, reaction: 'KO' }, null, worth).product, 'KO', 'a configured reaction is not second-guessed');
});

/** Three rooms with terminals and a fake Game.market recording calls. */
function marketWorld(opts) {
    fresh();
    const calls = [];
    const mkRoom = (name, storage, terminal, policy) => ({
        name, controller: { my: true, level: 8 },
        storage: { my: true, store: Object.assign(new Store(1e6, false), storage) },
        terminal: { my: true, cooldown: 0, store: Object.assign(new Store(3e5, false), terminal) },
        policy
    });
    const rooms = [
        mkRoom('W43S28', { O: 500000 }, { energy: 20000, O: 10000 }),
        mkRoom('W44S28', { O: 100000, KO: 18000 }, { energy: 20000, KO: 2000 }),
        mkRoom('W44S29', { K: 551000 }, { energy: 20000, K: 10000 }, (opts && opts.critical) ? 'CRITICAL' : 'STOCKPILE')
    ];
    const buy = {
        O: [{ id: 'o1', type: 'buy', resourceType: 'O', price: 18.051, amount: 6000, remainingAmount: 6000, roomName: 'W45S28' }],
        K: [{ id: 'k1', type: 'buy', resourceType: 'K', price: 15.0, amount: 2343, remainingAmount: 2343, roomName: 'W45S29' }]
    };
    const sell = {
        KO: [{ id: 's1', type: 'sell', resourceType: 'KO', price: 32.861, amount: 85, remainingAmount: 85, roomName: 'E1S1' }],
        O: [{ id: 's2', type: 'sell', resourceType: 'O', price: 0.01, amount: 1e6, remainingAmount: 1e6, roomName: 'E9S9' },
            { id: 's3', type: 'sell', resourceType: 'O', price: 19.5, amount: 8000, remainingAmount: 8000, roomName: 'W1S1' }],
        K: [{ id: 's4', type: 'sell', resourceType: 'K', price: 16.0, amount: 6000, remainingAmount: 6000, roomName: 'W2S2' }]
    };
    global.Game.market = {
        orders: (opts && opts.orders) || {},
        getHistory: (r) => HIST[r] || [],
        getAllOrders: (f) => ((f.type === 'buy' ? buy : sell)[f.resourceType] || []).slice(),
        calcTransactionCost: (n) => Math.ceil(n * 0.033),
        deal: (id, n, room) => { calls.push(['deal', id, n, room]); return OK; },
        createOrder: (o) => { calls.push(['create', o.resourceType, o.price, o.totalAmount, o.roomName]); return OK; },
        extendOrder: (id, n) => { calls.push(['extend', id, n]); return OK; },
        changeOrderPrice: (id, p) => { calls.push(['price', id, p]); return OK; }
    };
    global.Memory.rooms = {};
    const config = require('../src/config');
    config.set('market.enabled', true);
    config.set('market.energyValue', 0.5);
    if (opts && opts.sell) config.set('market.sell', opts.sell);
    const ctx = {
        config: config.get(),
        roomList: rooms.map(r => ({ name: r.name, room: r, kind: 'owned', policy: { phase: 'LABS', state: r.policy || 'GROW' } }))
    };
    return { calls, rooms, ctx, proc: require('../src/processes/act/market') };
}

test('act.market (defaults): own orders priced from trades and depth, never from spam', () => {
    const w = marketWorld();
    w.proc.run(w.ctx);
    assert.ok(!w.calls.some(c => c[0] === 'deal'));
    const created = Object.fromEntries(w.calls.filter(c => c[0] === 'create').map(c => [c[1], c]));
    assert.equal(created.O[4], 'W43S28');
    assert.equal(created.O[2], 19.305, 'O: 1% under the real seller at 19.5; the 0.01 spam line ignored');
    assert.equal(created.K[4], 'W44S29');
    assert.equal(created.K[2], 15.84, 'K: 1% under the 16.0 seller (above the K floor)');
    assert.equal(created.KO[4], 'W44S28');
    const value = require('../src/services/market').valuer(w.ctx.config.market);
    const kref = value('K');
    const oref = value('O');
    assert.ok(Math.abs(created.KO[2] - Math.round((kref + oref) * 1000) / 1000) < 0.002,
        `KO (thin, the 85-unit competitor is bait): priced at its reagents' value ${created.KO[2]}`);
    assert.ok(Memory.rooms.W43S28.mk.O && Memory.rooms.W44S28.mk.KO, 'floor anchors remembered per room');
});

test('act.market: floor falls slowly after a crash; CRITICAL room sells nothing; order topped up', () => {
    const order = { id: 'my1', type: 'sell', resourceType: 'KO', price: 40, remainingAmount: 1000, amount: 5000, roomName: 'W44S28' };
    const w = marketWorld({ critical: true, orders: { my1: order } });
    w.proc.run(w.ctx);
    assert.ok(!w.calls.some(c => c[0] === 'create' && c[1] === 'K'), 'CRITICAL W44S29 lists nothing');
    assert.deepEqual(w.calls.find(c => c[0] === 'extend'), ['extend', 'my1', 4000]);
    // Crash: O's history collapses overnight; our floor follows only slowly.
    const f0 = Memory.rooms.W43S28.mk.O.p;
    const crashed = HIST.O.map(d => ({ ...d, avgPrice: 1 }));
    Game.market.getHistory = (r) => (r === 'O' ? crashed : HIST[r] || []);
    delete global.__v2heap;
    Game.time += 20000;
    const { floor } = w.proc.floorFor(w.ctx.config.market, require('../src/services/market').valuer(w.ctx.config.market), 'O', w.ctx.config.market.sell.O, 'W43S28');
    assert.ok(Math.abs(floor - f0 * 0.95) < 1e-6, `a day later the floor is ${floor.toFixed(3)}, not ~0.9`);
});

test('act.market (deal mode): one deal per room, after the fee, above floor, keep held', () => {
    const DEALS = { KO: null, O: { mode: 'deal', keep: 100000, batch: 5000 }, K: { mode: 'deal', keep: 100000, batch: 5000 } };
    const w = marketWorld({ sell: DEALS });
    w.proc.run(w.ctx);
    const deals = w.calls.filter(c => c[0] === 'deal');
    assert.deepEqual(deals.find(c => c[1] === 'o1'), ['deal', 'o1', 5000, 'W43S28'], 'O from W43S28; W44S28 holds O at keep');
    assert.deepEqual(deals.find(c => c[1] === 'k1'), ['deal', 'k1', 2343, 'W44S29']);
    assert.equal(deals.length, 2);
});

test('market.stop on a default resource sticks; nothing stocked for it', () => {
    const w = marketWorld();
    require('../src/console/market').register();
    global.market.stop('O');
    const cfg = require('../src/config').get();
    assert.equal(cfg.market.sell.O, null);
    w.ctx.config = cfg;
    w.proc.run(w.ctx);
    assert.ok(!w.calls.some(c => c[1] === 'O' || c[1] === 'o1'), 'nothing done with O');
    assert.ok(w.calls.some(c => c[0] === 'create' && c[1] === 'KO'));
    assert.ok(!('O' in require('../src/services/market').stockFor(w.rooms[0], cfg.market)));
});

test('terminal stock: what a room sells is stocked in its terminal, rounded, up to the limit', () => {
    fresh();
    const m = require('../src/services/market');
    const cfg = { ...require('../src/config').get().market, enabled: true };
    const room = {
        terminal: { store: Object.assign(new Store(3e5, false), { O: 100 }) },
        storage: { store: Object.assign(new Store(1e6, false), { O: 103500, KO: 2500, K: 50000 }) }
    };
    assert.deepEqual(m.stockFor(room, cfg), { O: 4000, KO: 1000 });
    assert.deepEqual(m.stockFor(room, { ...cfg, enabled: false }), {});
});

test('sim: goods for sale are moved into the terminal by the lane hauler', () => {
    const { boot } = require('./helpers/runSim');
    const sim = boot({ spawn: [24, 20], sources: [[5, 5], [44, 44]], controller: [10, 40] }, {
        deterministic: true,
        config: { construction: { enabled: false }, market: { enabled: true, sell: { KO: { mode: 'order', keep: 2000 }, O: null, K: null } } }
    });
    const w = sim.world;
    const storage = w.addStructure('storage', 26, 20);
    const terminal = w.addStructure('terminal', 24, 21);
    for (let i = 0; i <= 11; i++) w.addStructure('road', 25 + i, 21 + i);
    for (let i = 1; i <= 10; i++) w.addStructure('extension', 26 + i, 21 + i);
    w.controller.level = 6;
    storage.store.energy = 300000;
    storage.store.KO = 18000;
    terminal.store.energy = 20000;
    global.Game.market = { orders: {}, getHistory: () => [], getAllOrders: () => [], calcTransactionCost: () => 0 };
    sim.run(1500);
    assert.equal(terminal.store.KO, 10000, `terminal KO ${terminal.store.KO}`);
    assert.equal(storage.store.KO + terminal.store.KO, 18000, 'nothing lost');
    assert.deepEqual(sim.logs.filter(l => /ERROR/.test(l)), []);
});
