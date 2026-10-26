'use strict';

/**
 * Buying (docs/v2/MARKET.md "Buying"): for a purpose only. Survival (boost
 * stock, emergency energy) and complements ("I hold this; another reagent
 * lets me sell it better"). Mirrored guards: ceiling, slow rise, thin markets,
 * spam and bait, credit reserve, daily cap.
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
    return require('../src/services/marketBuy');
}

test('ceiling: 1.1 × trade reference, your maxPrice caps it; thin market only with maxPrice; slow rise', () => {
    const b = fresh();
    assert.ok(Math.abs(b.rawCeiling(10, undefined, 1.1) - 11) < 1e-9);
    assert.equal(b.rawCeiling(10, 10.5, 1.1), 10.5);
    assert.equal(b.rawCeiling(null, undefined, 1.1), null, 'thin, no maxPrice: never buy');
    assert.equal(b.rawCeiling(null, 50, 1.1), 50, 'thin, but you set a maxPrice (a boost you need)');
    const T = require('../src/services/market').TICKS_PER_DAY;
    let r = b.limitRise(10, undefined, 0, 0.05);
    r = b.limitRise(100, r.anchor, T, 0.05);
    assert.equal(r.ceiling, 10.5, 'a spike to 100 a day later: ceiling only 5% higher');
    assert.equal(b.limitRise(5, { p: 10, t: 0 }, 1, 0.05).ceiling, 5, 'falls at once');
});

test('deal buying: cheapest after the fee we pay, never above the ceiling', () => {
    const b = fresh();
    const dist = { FAR: 80, NEAR: 1 };
    const cost = (n, from) => Math.ceil(n * (1 - Math.exp(-dist[from] / 30)));
    const sells = [{ id: 'far', price: 9, amount: 5000, roomName: 'FAR' }, { id: 'near', price: 10, amount: 5000, roomName: 'NEAR' }];
    const best = b.bestAsk(sells, { amount: 3000, ceiling: 11, energyValue: 2, energyAvail: 50000, cost });
    assert.equal(best.order.id, 'near', 'the cheaper listing costs more once its transfer is paid');
    assert.equal(b.bestAsk(sells, { amount: 3000, ceiling: 9.5, energyValue: 1, energyAvail: 50000, cost }), null);
});

test('budget: never below the credit reserve, at most the daily cap, new day resets', () => {
    const b = fresh();
    const cfg = { creditReserve: 100000, dailyCap: 30000 };
    assert.equal(b.budget(289000, undefined, 5, cfg), 30000);
    assert.equal(b.budget(289000, { d: 5, s: 25000 }, 5, cfg), 5000);
    assert.equal(b.budget(110000, undefined, 5, cfg), 10000, 'reserve first');
    assert.equal(b.budget(90000, undefined, 5, cfg), 0);
    assert.equal(b.budget(289000, { d: 4, s: 30000 }, 5, cfg), 30000, 'yesterday is forgotten');
    assert.deepEqual(b.record({ d: 5, s: 100 }, 5, 50), { d: 5, s: 150 });
});

test('complement: only the partner of what we hold, only if the product sells better', () => {
    const b = fresh();
    const c = { margin: 0.10, anchorMin: 20000 };
    const value = (r) => ({ O: 18.6, K: 15.2, H: 5, OH: 40, KH: 22 }[r] ?? null);
    const cost = (r) => ({ H: 5.5, O: 19, K: 16 }[r] ?? null);
    // We hold 100k O. OH 40 ≥ (O 18.6 + H 5.5) × 1.1 = 26.5: buy H.
    let p = b.complement({ O: 100000 }, value, cost, c, 15000);
    assert.deepEqual([p.anchor, p.partner, p.product, p.amount], ['O', 'H', 'OH', 15000]);
    // We hold nothing: never buy both reagents.
    assert.equal(b.complement({}, value, cost, c, 15000), null);
    // Below the anchor minimum: not a stockpile.
    assert.equal(b.complement({ O: 15000 }, value, cost, c, 15000), null);
    // Never more partner than the anchor we can react it with.
    p = b.complement({ O: 21000, H: 0 }, value, cost, c, 30000);
    assert.equal(p.amount, 21000);
    // Already have enough partner: nothing to buy.
    assert.equal(b.complement({ O: 100000, H: 15000, K: 0 }, value, cost, c, 15000), null);
    // Product without a trusted price (thin): don't.
    assert.equal(b.complement({ O: 100000 }, (r) => ({ O: 18.6, H: 5 }[r] ?? null), cost, c, 15000), null);
    // Not enough better than selling O as it is: don't.
    assert.equal(b.complement({ O: 100000 }, (r) => ({ O: 18.6, H: 5, OH: 25 }[r] ?? null), cost, c, 15000), null);
});

/** Lab room W44S28 with O, plus a poorer room; fake market. */
function buyWorld(opts) {
    fresh();
    const w = createWorld({ spawn: [25, 25], sources: [[10, 10]], controller: [40, 40] });
    for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'src'))) delete require.cache[k];
    const calls = [];
    w.room.controller.level = 8;
    const labs = [[30, 10], [31, 10], [29, 11]].map(([x, y]) => w.addStructure('lab', x, y));
    const mkRoom = (name, storage, terminalE, rcl) => ({
        name, controller: { my: true, level: rcl || 8 }, find: () => [],
        storage: { my: true, store: Object.assign(new Store(1e6, false), storage) },
        terminal: { my: true, cooldown: 0, store: Object.assign(new Store(3e5, false), { energy: terminalE }) }
    });
    const st = w.addStructure('storage', 20, 20);
    Object.assign(st.store, { O: 100000, energy: (opts && opts.labEnergy) || 300000 });
    const tm = w.addStructure('terminal', 21, 20);
    tm.cooldown = 0;
    tm.store.energy = 20000;
    const labRoom = w.room;
    const poor = opts && opts.poorEnergy !== undefined ? mkRoom('W2N2', {}, opts.poorEnergy) : mkRoom('W2N2', { energy: 300000 }, 20000);
    const day = (avg, tx) => ({ date: '2026-10-26', avgPrice: avg, volume: tx * 1000, transactions: tx });
    const hist = { O: [day(18.6, 3000)], H: [day(5, 3000)], OH: [day(40, 3000)], energy: [day(17, 9000)], XGHO2: [day(60, 500)] };
    const sells = {
        energy: [{ id: 'e1', type: 'sell', resourceType: 'energy', price: 17.5, amount: 50000, remainingAmount: 50000, roomName: 'W3N3' }],
        XGHO2: [{ id: 'x1', type: 'sell', resourceType: 'XGHO2', price: 62, amount: 5000, remainingAmount: 5000, roomName: 'W3N3' },
            { id: 'bait', type: 'sell', resourceType: 'XGHO2', price: 30, amount: 50, remainingAmount: 50, roomName: 'E8S8' },
            { id: 'spam', type: 'sell', resourceType: 'XGHO2', price: 6000, amount: 1e6, remainingAmount: 1e6, roomName: 'E9S9' }]
    };
    const buys = { H: [{ id: 'hb', type: 'buy', resourceType: 'H', price: 4.8, amount: 20000, remainingAmount: 20000, roomName: 'E1S1' }] };
    global.Game.rooms = { W1N1: labRoom, W2N2: poor };
    global.Game.market = {
        credits: (opts && opts.credits) || 1e6,
        orders: (opts && opts.orders) || {},
        getHistory: (r) => hist[r] || [],
        getAllOrders: (f) => ((f.type === 'sell' ? sells : buys)[f.resourceType] || []).slice(),
        calcTransactionCost: (n) => Math.ceil(n * 0.033),
        deal: (id, n, room) => { calls.push(['deal', id, n, room]); return OK; },
        createOrder: (o) => { calls.push(['create', o.type, o.resourceType, o.price, o.totalAmount, o.roomName]); return OK; }
    };
    global.Memory.e = {};
    const config = require('../src/config');
    if (!(opts && opts.off)) config.set('market.buy.enabled', true);
    if (opts && opts.stock) config.set('market.buy.stock', opts.stock);
    config.set('market.buy.dailyCap', (opts && opts.dailyCap) || 1e6);
    config.set('market.buy.creditReserve', 100000);
    const ctx = {
        config: config.get(),
        roomList: [labRoom, poor].map(r => ({ name: r.name, room: r, kind: 'owned' }))
    };
    void labs;
    return { calls, ctx, proc: require('../src/processes/act/marketBuy') };
}

test('act.marketBuy: off by default, nothing happens', () => {
    const w = buyWorld({ off: true });
    w.proc.run(w.ctx);
    assert.deepEqual(w.calls, []);
});

test('act.marketBuy: a buy order for H to react with the O the lab room holds; one at a time; spend recorded', () => {
    const w = buyWorld();
    w.proc.run(w.ctx);
    const c = w.calls.filter(x => x[0] === 'create');
    assert.equal(c.length, 1);
    assert.deepEqual([c[0][1], c[0][2], c[0][5]], ['buy', 'H', 'W1N1']);
    assert.ok(c[0][3] <= 5 * 1.1 && c[0][3] > 4.8, `just above the 4.8 competitor, under the ceiling: ${c[0][3]}`);
    assert.equal(c[0][4], 15000, 'minReagent × 1.5');
    assert.ok(Memory.e.mb && Memory.e.mb.s > 0, 'spend recorded');
    const again = buyWorld({ orders: { o1: { id: 'o1', type: 'buy', resourceType: 'H', roomName: 'W1N1', remainingAmount: 9000, price: 5 } } });
    again.proc.run(again.ctx);
    assert.ok(!again.calls.some(x => x[0] === 'create'), 'no second order while one is open');
});

test('act.marketBuy: the daily cap and credit reserve hold', () => {
    let w = buyWorld({ credits: 110000 });
    w.proc.run(w.ctx);
    let c = w.calls.find(x => x[0] === 'create');
    assert.ok(c, 'still buys what the 10,000 above the reserve allows');
    assert.ok(c[3] * c[4] * 1.05 <= 10000 + 1, `spent ${c[3] * c[4] * 1.05}`);
    w = buyWorld({ dailyCap: 8000 });
    Memory.e.mb = { d: 0, s: 2000 };
    w.proc.run(w.ctx);
    c = w.calls.find(x => x[0] === 'create');
    assert.ok(c && c[3] * c[4] * 1.05 <= 6000 + 1, 'what is left of today\'s cap');
    const broke = buyWorld({ credits: 99000 });
    broke.proc.run(broke.ctx);
    assert.deepEqual(broke.calls, [], 'below the reserve: nothing');
});

test('act.marketBuy: emergency energy only when no room can send any', () => {
    let w = buyWorld({ poorEnergy: 5000, labEnergy: 500000 });
    w.proc.run(w.ctx);
    assert.ok(!w.calls.some(x => x[0] === 'deal' && x[1] === 'e1'), 'W1N1 has 500k to spare: let balancing send it');
    w = buyWorld({ poorEnergy: 5000, labEnergy: 100000 });
    w.proc.run(w.ctx);
    const d = w.calls.find(x => x[0] === 'deal' && x[1] === 'e1');
    assert.deepEqual(d, ['deal', 'e1', 15000, 'W2N2'], 'nobody to spare: buy what W2N2 needs to reach 20k');
});

test('act.marketBuy: boost stock bought below 80% of its minimum, spam and bait listings ignored', () => {
    const w = buyWorld({ stock: { XGHO2: 3000 } });
    w.proc.run(w.ctx);
    const d = w.calls.find(x => x[0] === 'deal' && x[1] !== 'e1');
    assert.deepEqual(d, ['deal', 'x1', 3000, 'W1N1'], 'bought from the real 62 listing into the lab room');
});
