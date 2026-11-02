'use strict';

/**
 * Boost baseline (docs/v2/LABS_CHAIN.md): a reserve of boosts kept for our
 * own defense/attack, refilled through whole recipe chains before anything is
 * made for sale, never sold and never used as a reagent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createWorld } = require('./helpers/sim');
const { boot } = require('./helpers/runSim');
const { storeMoves, flips } = require('./helpers/flow');

const ROOT = path.join(__dirname, '..');
function fresh() {
    createWorld({ spawn: [25, 25], sources: [[10, 10]], controller: [40, 40] });
    for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'src'))) delete require.cache[k];
    delete global.__v2heap;
    return require('../src/services/labChain');
}

// W44S28 on 2026-11-02 (storage + terminal, ≥ 1000, plus UH).
const LIVE = { O: 99085, LO: 5500, OH: 4635, GHO2: 17545, LHO2: 1865, ZO: 33526, XLHO2: 6835, XGHO2: 7310, UO: 40000, UH: 684,
    K: 98030, KO: 20350, KHO2: 12120, L: 5000, G: 5000, H: 7358, ZH: 5000, Z: 11967, X: 5000 };
const BASELINE = { XLHO2: 10000, XGHO2: 10000, KHO2: 3000, UH2O: 3000, ZHO2: 2000 };

test('live stock: heal first; the missing LHO2 is made in one run before XLHO2; buys only U and X', () => {
    const chain = fresh();
    const p = chain.plan(LIVE, BASELINE);
    assert.deepEqual(p.short, { XLHO2: 3165, XGHO2: 2690, UH2O: 3000, ZHO2: 2000 }, 'KHO2 is already full');
    assert.deepEqual(p.step, { target: 'XLHO2', product: 'LHO2', reagents: ['LO', 'OH'], amount: 1300 });
    // X: 3165 + 2690 for both tier 3 boosts, 5000 held. U: UH 3000 - 684 held. H, O, ZO, GHO2: enough.
    assert.deepEqual(p.wants, { X: 855, U: 2316 });
    assert.equal(p.reason, 'reserve_refill');
});

test('chain steps: with LHO2 made, XLHO2 runs; full reserve: nothing to do', () => {
    const chain = fresh();
    let p = chain.plan({ ...LIVE, LHO2: 3165, LO: 4200, OH: 3335 }, BASELINE);
    assert.equal(p.step.product, 'XLHO2');
    assert.equal(p.step.amount, 3165);
    const full = { ...LIVE, XLHO2: 10000, XGHO2: 10000, UH2O: 3000, ZHO2: 2000 };
    p = chain.plan(full, BASELINE);
    assert.equal(p.step, null);
    assert.deepEqual(p.wants, {});
    assert.equal(p.reason, 'reserve_full');
});

test('nothing reserved is used as a reagent; a base mineral short is bought, a compound is made', () => {
    const chain = fresh();
    // KHO2 is reserved (3000); 3500 held: only 500 free. Never a reagent below that.
    assert.deepEqual(chain.free({ KHO2: 3500, O: 10 }, { KHO2: 3000 }), { KHO2: 500, O: 10 });
    // A reserved boost that is also a reagent elsewhere is not spent on it.
    const p = chain.plan({ UH2O: 3000, X: 5000 }, { UH2O: 3000, XUH2O: 1000 });
    assert.equal(p.step, null, 'UH2O is reserved; making XUH2O from it would eat the reserve');
    assert.ok(p.wants.U > 0 && p.wants.H > 0, 'so UH2O for it is made from scratch: U and H wanted');
    // No U at all: nothing runs, U wanted, waiting reason.
    const q = chain.plan({ H: 10000, OH: 10000 }, { UH2O: 3000 });
    assert.equal(q.step, null);
    assert.deepEqual(q.wants, { U: 3000 });
    assert.equal(q.reason, 'reserve_waiting_for_reagents');
});

test('selling keeps the reserve: sellKeep is at least the baseline', () => {
    fresh();
    const market = require('../src/services/market');
    const labCfg = { enabled: true, rooms: { W1N1: { reserve: { KHO2: 3000 } } } };
    assert.equal(market.sellKeep({ mode: 'order', keep: 0 }, 'KHO2', 'W1N1', labCfg), 3000);
    assert.equal(market.sellKeep({ mode: 'order', keep: 5000 }, 'KHO2', 'W1N1', labCfg), 5000);
    assert.equal(market.sellKeep({ mode: 'order', keep: 0 }, 'KHO2', 'W9N9', labCfg), 0, 'other rooms unaffected');
});

/** Six labs: two in the middle row, four within 2 of both. */
const CLUSTER = [[30, 10], [31, 10], [29, 11], [32, 11], [30, 12], [31, 12]];

/** A lab room (W1N1) with six labs, a lane and the given storage. */
function labRoom(labsCfg, contents) {
    fresh();
    const sim = boot({ spawn: [24, 20], sources: [[5, 5], [44, 44]], controller: [10, 40] }, {
        deterministic: true,
        config: { construction: { enabled: false }, terminal: { energy: 20000, energyMargin: 2000, stock: {} }, labs: labsCfg }
    });
    const w = sim.world;
    const storage = w.addStructure('storage', 26, 20);
    const terminal = w.addStructure('terminal', 24, 21);
    for (let i = 0; i <= 11; i++) w.addStructure('road', 25 + i, 21 + i);
    const ext = [];
    for (let i = 1; i <= 10; i++) for (const d of [-1, 1]) ext.push(w.addStructure('extension', 25 + i + (d > 0 ? 1 : 0), 21 + i + (d < 0 ? 1 : 0)));
    const labList = CLUSTER.map(([x, y]) => w.addStructure('lab', x, y));
    w.controller.level = 7;
    for (const e of ext) {
        e.store._cap = 100;
        e.store.energy = 100;
    }
    Object.assign(storage.store, { energy: 400000 }, contents);
    terminal.store.energy = 20000;
    w.carryLog = [];
    const total = (r) => (storage.store[r] || 0) + (terminal.store[r] || 0) + labList.reduce((t, l) => t + (l.store[r] || 0), 0) +
        Object.values(Game.creeps).reduce((t, c) => t + (c.store[r] || 0), 0);
    return { sim, w, storage, labList, total };
}

test('sim: the reserve is refilled through the chain (LO + OH → LHO2, + X → XLHO2), no back and forth', () => {
    const { sim, w, storage, labList, total } = labRoom({ rooms: { W1N1: { reserve: { XLHO2: 1000 } } } }, { LO: 3000, OH: 3000, X: 3000 });
    let ticks = 0;
    while (total('XLHO2') < 1000 && ticks < 9000) {
        sim.run(1);
        ticks++;
    }
    assert.ok(total('XLHO2') >= 1000, `XLHO2 ${total('XLHO2')} after ${ticks} ticks`);
    // Every unit accounted for: 1000 LO and OH became LHO2, all of it became XLHO2.
    assert.equal(total('LO') + total('LHO2') + total('XLHO2'), 3000);
    assert.equal(total('X') + total('XLHO2'), 3000);
    const switches = sim.logs.filter(l => /\[labs\] W1N1/.test(l));
    assert.deepEqual(switches.map(l => (l.match(/→ (\w+)/) || [])[1]), ['LHO2', 'XLHO2'], `one run per step: ${switches.join(' | ')}`);
    // Full: the planner stops reacting it (no sale recipe qualifies here).
    sim.run(300);
    assert.ok(total('XLHO2') <= 1000 + 5 * labList.length * 2, `stops at the baseline: ${total('XLHO2')}`);
    assert.equal(require('../src/services/labChain').snapshot('W1N1').reason, 'reserve_full');
    const moves = storeMoves(w.carryLog);
    assert.deepEqual(flips(moves.filter(m => m.r === 'energy'), storage.id, {}), [], 'no energy flips');
    assert.deepEqual(sim.logs.filter(l => /ERROR/.test(l)), [], 'flip guard never fired');
});

test('sim: with the reserve full, a stock-target recipe never uses reserved KHO2', () => {
    // XKHO2 has a production stock target, so it qualifies; KHO2 3500 held, 3000 of it reserved.
    const { sim, total } = labRoom({
        rooms: { W1N1: { reserve: { KHO2: 3000 } } },
        production: { margin: 0.2, minBatch: 1000, batch: 5000, stock: { XKHO2: 2000 } }
    }, { KHO2: 3500, X: 5000 });
    sim.run(1500);
    assert.equal(total('XKHO2'), 0, 'nothing made from the reserve');
    assert.equal(total('KHO2'), 3500);
    const off = labRoom({ production: { margin: 0.2, minBatch: 1000, batch: 5000, stock: { XKHO2: 2000 } } }, { KHO2: 3500, X: 5000 });
    off.sim.run(1500);
    assert.ok(off.total('XKHO2') > 0, 'without the reserve the same room does make it (the test can fail)');
});
