'use strict';

/**
 * Auto market (docs/v2/MARKET.md): price floor from history, deals judged
 * after the energy fee, own sell orders for products nobody buys, keep levels,
 * and the terminal stocked with what's for sale.
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

// Shard3 on 2026-10-26: O buy orders at 18.051, KO none, energy ~17.
const day = (date, avgPrice, volume) => ({ date, avgPrice, volume });
const HIST = {
    O: [day('2026-10-24', 18, 100000), day('2026-10-25', 18.2, 120000), day('2026-10-26', 17.8, 90000)],
    KO: [day('2026-10-22', 35.5, 119), day('2026-10-23', 34.9, 51)],
    K: [day('2026-10-25', 11.5, 40000), day('2026-10-26', 11.2, 30000)],
    energy: [day('2026-10-25', 17, 1e8), day('2026-10-26', 17, 1e8)]
};

test('floor: 90% of the volume-weighted recent average, or minPrice if higher; none without data', () => {
    fresh();
    const m = require('../src/services/market');
    const avg = m.avgPrice(HIST.O, 3);
    assert.ok(Math.abs(avg - 18.02) < 0.01, `avg ${avg}`);
    assert.ok(Math.abs(m.floor({ mode: 'deal', keep: 0 }, avg, 0.9) - 16.22) < 0.01);
    assert.equal(m.floor({ mode: 'deal', keep: 0, minPrice: 17 }, avg, 0.9), 17);
    assert.equal(m.floor({ mode: 'deal', keep: 0 }, null, 0.9), null, 'no history, no minPrice: never sell');
});

test('deal: judged after the energy fee; a far buyer at a higher price can lose', () => {
    fresh();
    const m = require('../src/services/market');
    const orders = [
        { id: 'far', price: 18.5, amount: 5000, roomName: 'E39S4' },
        { id: 'near', price: 18.0, amount: 5000, roomName: 'W45S28' }
    ];
    const dist = { E39S4: 80, W45S28: 1 };
    const cost = (n, to) => Math.ceil(n * (1 - Math.exp(-dist[to] / 30)));
    // Fees: far 4,653 energy, near 164 energy for 5,000 units.
    const opt = (ev, fl) => ({ amount: 5000, floor: fl, energyValue: ev, energyAvail: 50000, cost, mine: new Set() });
    assert.equal(m.bestDeal(orders, opt(0.1, 16.2)).order.id, 'far', 'cheap energy: the higher price wins (18.41 vs 18.00)');
    assert.equal(m.bestDeal(orders, opt(1, 16.2)).order.id, 'near', 'at 1 credit/energy the near buyer nets more (17.97 vs 17.57)');
    const at17 = m.bestDeal(orders, opt(17, 16.2));
    assert.equal(at17.order.id, 'near', 'at 17 credits/energy only the near buyer clears the floor (17.44; far 2.68)');
    assert.equal(m.bestDeal(orders, opt(17, 17.5)), null, 'nothing above floor after the fee: no deal');
    // Our own orders are never dealt with.
    assert.equal(m.bestDeal([orders[1]], { amount: 5000, floor: 1, energyValue: 0, energyAvail: 50000, cost, mine: new Set(['near']) }), null);
    // Short of energy: the amount shrinks to what the terminal can pay for.
    const small = m.bestDeal([orders[1]], { amount: 5000, floor: 1, energyValue: 0, energyAvail: 100, cost, mine: new Set() });
    assert.ok(small && small.energyCost <= 100 && small.amount < 5000, JSON.stringify(small));
});

test('own order price: just under the cheapest competitor, never below floor', () => {
    fresh();
    const m = require('../src/services/market');
    assert.equal(m.orderPrice([{ id: 'a', price: 32.861, amount: 85 }, { id: 'b', price: 40, amount: 10 }], 31.5, 35.3), 32.532);
    assert.equal(m.orderPrice([{ id: 'a', price: 20, amount: 85 }], 31.5, 35.3), 31.5, 'floor holds');
    assert.equal(m.orderPrice([], 31.5, 35.3), 35.3, 'no competition: recent average');
});

/** Two rooms with terminals and a fake Game.market recording calls. */
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
        mkRoom('W43S28', { O: 500000, KO: 0 }, { energy: 20000, O: 10000 }),
        mkRoom('W44S28', { O: 100000, KO: 18000 }, { energy: 20000, KO: 2000 }),
        mkRoom('W44S29', { K: 551000 }, { energy: 20000, K: 10000 }, (opts && opts.critical) ? 'CRITICAL' : 'STOCKPILE')
    ];
    const buy = {
        O: [{ id: 'o1', type: 'buy', resourceType: 'O', price: 18.051, amount: 6000, remainingAmount: 6000, roomName: 'W45S28' }],
        K: [{ id: 'k1', type: 'buy', resourceType: 'K', price: 11.383, amount: 2343, remainingAmount: 2343, roomName: 'W45S29' }]
    };
    const sell = { KO: [{ id: 's1', type: 'sell', resourceType: 'KO', price: 32.861, amount: 85, remainingAmount: 85 }] };
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
    const config = require('../src/config');
    config.set('market.energyValue', 0.5);
    if (opts && opts.sell) config.set('market.sell', opts.sell);
    const ctx = {
        config: config.get(),
        roomList: rooms.map(r => ({ name: r.name, room: r, kind: 'owned', policy: { phase: 'LABS', state: r.policy || 'GROW' } }))
    };
    return { calls, rooms, ctx, proc: require('../src/processes/act/market') };
}

const DEALS = { KO: { mode: 'order', keep: 2000 }, O: { mode: 'deal', keep: 100000, batch: 5000 }, K: { mode: 'deal', keep: 100000, batch: 5000 } };

test('act.market (deal mode): sells surplus O and K into buy orders, KO by our own order; keep levels hold', () => {
    const w = marketWorld({ sell: DEALS });
    w.proc.run(w.ctx);
    const deals = w.calls.filter(c => c[0] === 'deal');
    assert.deepEqual(deals.map(c => c[3]).sort(), ['W43S28', 'W44S29'], 'O from W43S28, K from W44S29; W44S28 holds O at keep');
    assert.deepEqual(deals.find(c => c[1] === 'o1'), ['deal', 'o1', 5000, 'W43S28'], 'O: one batch');
    assert.deepEqual(deals.find(c => c[1] === 'k1'), ['deal', 'k1', 2343, 'W44S29'], 'K: all the buyer wants');
    const create = w.calls.find(c => c[0] === 'create');
    assert.deepEqual(create, ['create', 'KO', 32.532, 5000, 'W44S28'], 'KO order just under 32.861, in the room with KO');
});

test('act.market: no deal from a CRITICAL room; existing order is topped up and re-priced', () => {
    const order = { id: 'my1', type: 'sell', resourceType: 'KO', price: 34, remainingAmount: 1000, amount: 5000, roomName: 'W44S28' };
    const w = marketWorld({ critical: true, orders: { my1: order }, sell: DEALS });
    w.proc.run(w.ctx);
    assert.ok(!w.calls.some(c => c[0] === 'deal' && c[3] === 'W44S29'), 'CRITICAL room sells nothing');
    assert.ok(!w.calls.some(c => c[0] === 'create'), 'no second KO order');
    assert.deepEqual(w.calls.find(c => c[0] === 'extend'), ['extend', 'my1', 4000], 'topped up to 5000');
    assert.deepEqual(w.calls.find(c => c[0] === 'price'), ['price', 'my1', 32.532], 're-priced under the competitor');
});

test('terminal stock: what a room sells is stocked in its terminal, rounded, up to the limit', () => {
    fresh();
    const m = require('../src/services/market');
    const cfg = require('../src/config').get().market;
    const room = {
        terminal: { store: Object.assign(new Store(3e5, false), { O: 100 }) },
        storage: { store: Object.assign(new Store(1e6, false), { O: 103500, KO: 2500, K: 50000 }) }
    };
    assert.deepEqual(m.stockFor(room, cfg), { O: 4000, KO: 1000 }, 'O surplus 3600 → 4000; KO 500 → 1000; K under keep');
    assert.deepEqual(m.stockFor(room, { ...cfg, enabled: false }), {});
});

test('act.market (defaults): O, K and KO each get one own sell order, in the room with the most surplus', () => {
    const w = marketWorld();
    w.proc.run(w.ctx);
    assert.ok(!w.calls.some(c => c[0] === 'deal'), 'no deals: the buyer pays the fee on our orders');
    const created = w.calls.filter(c => c[0] === 'create').map(c => [c[1], c[4], c[3]]).sort();
    assert.deepEqual(created, [['K', 'W44S29', 5000], ['KO', 'W44S28', 5000], ['O', 'W43S28', 5000]]);
    const o = w.calls.find(c => c[0] === 'create' && c[1] === 'O');
    assert.ok(o[2] >= 16.2, `O never below the floor: ${o[2]}`);
});

test('market.stop on a default resource sticks (config merge keeps the null)', () => {
    const w = marketWorld();
    require('../src/console/market').register();
    global.market.stop('O');
    const cfg = require('../src/config').get().market;
    assert.equal(cfg.sell.O, null);
    w.ctx.config = require('../src/config').get();
    w.proc.run(w.ctx);
    assert.ok(!w.calls.some(c => c[1] === 'O' || c[1] === 'o1'), 'nothing done with O');
    assert.ok(w.calls.some(c => c[0] === 'create' && c[1] === 'KO'), 'KO still sold');
    const m = require('../src/services/market');
    assert.ok(!('O' in m.stockFor(w.rooms[0], cfg)), 'no terminal stock for O');
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
    assert.equal(terminal.store.KO, 10000, `terminal KO ${terminal.store.KO} (surplus 16000, stock limit 10000)`);
    assert.equal(storage.store.KO + terminal.store.KO, 18000, 'nothing lost');
    assert.deepEqual(sim.logs.filter(l => /ERROR/.test(l)), []);
});
