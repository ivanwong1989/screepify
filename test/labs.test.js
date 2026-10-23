'use strict';

/**
 * Labs (P12 / LOGISTICS.md L4): layout, reaction choice, lab bands, and the
 * whole thing in the simulator (reactions run, product goes to storage,
 * reaction switches empty and refill labs, boost stock), audited like the
 * economy soak: no store passes a resource back and forth.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createWorld, Store } = require('./helpers/sim');
const { boot } = require('./helpers/runSim');
const { storeMoves, flips } = require('./helpers/flow');

const ROOT = path.join(__dirname, '..');
function fresh() {
    createWorld({ spawn: [25, 25], sources: [[10, 10]], controller: [40, 40] });
    for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'src'))) delete require.cache[k];
    delete global.__v2heap;
}

const CFG = {
    enabled: true, reaction: 'auto', inputTarget: 2000, outputMax: 1500, boostTarget: 1000,
    minReagent: 10000, keepReagent: 2000, productCap: 20000, boosts: {}, rooms: {}
};
/** Six labs: two in the middle row, four within 2 of both. */
const CLUSTER = [[30, 10], [31, 10], [29, 11], [32, 11], [30, 12], [31, 12]];
const fakeLab = (id, x, y, content) => ({ id, structureType: 'lab', my: true, pos: { x, y }, store: Object.assign(new Store(5000), content || {}) });

test('layout: the input pair every other lab can react with', () => {
    fresh();
    const labs = require('../src/services/labs');
    const list = CLUSTER.map(([x, y], i) => fakeLab(`l${i}`, x, y));
    const lay = labs.layout(list);
    assert.equal(lay.outputs.length, 4);
    for (const o of lay.outputs) {
        const ol = list.find(l => l.id === o);
        for (const i of lay.inputs) assert.ok(labs.range(ol, list.find(l => l.id === i)) <= 2);
    }
    assert.equal(labs.layout(list.slice(0, 2)), null, 'needs 3 labs');
});

test('reaction: auto uses the biggest stockpiles, sticks while it can, honours config', () => {
    fresh();
    const labs = require('../src/services/labs');
    // W44S28 on 2026-10-23 (storage + terminal).
    const live = { O: 143272, K: 131000, H: 7745, L: 10500, Z: 5250, X: 5000, UO: 40000, OH: 13760, ZO: 33526 };
    assert.deepEqual(labs.chooseReaction(live, CFG, null), { reagents: ['K', 'O'], product: 'KO' });
    // Kept while reagents last, even if another pair is now bigger.
    assert.equal(labs.chooseReaction({ ...live, K: 3000, L: 100000 }, CFG, 'KO').product, 'KO');
    // Dropped when a reagent runs low or the product hits its cap.
    assert.equal(labs.chooseReaction({ ...live, K: 1000 }, CFG, 'KO').product, 'LO');
    assert.equal(labs.chooseReaction({ ...live, KO: 20000 }, CFG, 'KO').product, 'LO');
    assert.equal(labs.chooseReaction({ O: 500, K: 500 }, CFG, null), null);
    assert.deepEqual(labs.chooseReaction(live, { ...CFG, reaction: 'OH' }, null), { reagents: ['H', 'O'], product: 'OH' });
});

test('lab bands: reagent in, product out, wrong mineral out first', () => {
    fresh();
    const bands = require('../src/services/bands');
    const info = (roles) => ({ terminal: { energy: 0, stock: {}, rooms: {} }, roomName: 'W1N1', miningContainers: new Set(), labs: roles, labCfg: CFG });
    const inLab = fakeLab('a', 0, 0);
    assert.deepEqual(bands.band(inLab, 'K', info({ a: { kind: 'in', res: 'K' } })), { min: 1000, target: 2000, max: 3000 });
    const outLab = fakeLab('b', 0, 0, { KO: 1600 });
    assert.deepEqual(bands.band(outLab, 'KO', info({ b: { kind: 'out', res: 'KO' } })), { min: 0, target: 0, max: 1500 });
    const wrong = fakeLab('c', 0, 0, { H: 800 });
    const roles = { c: { kind: 'in', res: 'K' } };
    assert.equal(bands.band(wrong, 'K', info(roles)), null, 'no K while H is in it');
    assert.deepEqual(bands.band(wrong, 'H', info(roles)), bands.OFFER_ALL, 'H offered');
    assert.equal(bands.band(inLab, 'energy', info({ a: { kind: 'in', res: 'K' } })), null, 'lab energy left alone');
    assert.deepEqual(bands.band(fakeLab('d', 0, 0, { O: 5 }), 'O', info({})), bands.OFFER_ALL, 'idle lab offers');
});

/** RCL 7 room with a lane, storage, terminal and a six-lab cluster. */
function labRoom(config) {
    const sim = boot({ spawn: [24, 20], sources: [[5, 5], [44, 44]], controller: [10, 40] }, {
        deterministic: true,
        config: Object.assign({ construction: { enabled: false }, terminal: { energy: 20000, energyMargin: 2000, stock: {} } }, config || {})
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
    Object.assign(storage.store, { energy: 400000, K: 100000, O: 100000, H: 30000, XGHO2: 5000 });
    terminal.store.energy = 20000;
    w.carryLog = [];
    return Object.assign(sim, { w, storage, terminal, ext, labs: labList });
}

const errors = (sim) => sim.logs.filter(l => /ERROR/.test(l));

test('sim: labs make KO, product goes to storage, nothing passes back and forth', () => {
    const sim = labRoom();
    for (let t = 0; t < 4000; t++) {
        // Spawning empties half the lane every 150 ticks.
        if (t % 150 === 0) sim.ext.forEach((e, i) => { if (i % 2 === (t / 150) % 2) e.store.energy = 0; });
        sim.run(1);
    }
    const haulers = Object.values(Game.creeps).filter(c => c.memory.m === 'labs:W1N1');
    assert.equal(haulers.length, 1, 'one lab hauler');
    assert.ok((sim.w.stats.reactions || 0) > 500, `reactions ${sim.w.stats.reactions}`);
    // Every unit made is in storage or still in an output lab (≤ 1500 each before it's offered).
    const inLabs = sim.labs.reduce((t, l) => t + (l.store.KO || 0), 0);
    const carried = Object.values(Game.creeps).reduce((t, c) => t + (c.store.KO || 0), 0);
    assert.equal((sim.storage.store.KO || 0) + inLabs + carried, sim.w.stats.reactions * 5, 'all KO accounted for');
    assert.ok((sim.storage.store.KO || 0) >= 1500, `KO in storage ${sim.storage.store.KO}`);
    // Output labs are emptied once above 1500, so they never fill up (3000) and stall.
    assert.ok(sim.labs.every(l => (l.store.KO || 0) < 2500), `output labs ${sim.labs.map(l => l.store.KO || 0)}`);
    const moves = storeMoves(sim.w.carryLog);
    // Reactions change labs from outside the move log: every reaction tick counts.
    const outside = {};
    assert.deepEqual(flips(moves.filter(m => m.r !== 'KO' && m.r !== 'K' && m.r !== 'O'), sim.storage.id, outside), [], 'no flips (other resources)');
    // Per lab: inputs only ever receive their reagent, outputs only ever give KO.
    // (Energy for boosting is topped up separately by logistics supply.)
    const lab = (id) => sim.labs.find(l => l.id === id);
    const mineralMoves = moves.filter(m => m.r !== 'energy');
    assert.ok(mineralMoves.filter(m => lab(m.to)).every(m => m.r === 'K' || m.r === 'O'), 'only reagents delivered to labs');
    assert.ok(mineralMoves.filter(m => lab(m.from)).every(m => m.r === 'KO'), 'only KO taken from labs');
    const ins = new Set(mineralMoves.filter(m => lab(m.to)).map(m => m.to));
    const outs = new Set(mineralMoves.filter(m => lab(m.from)).map(m => m.from));
    assert.deepEqual([...ins].filter(id => outs.has(id)), [], 'no lab both filled and emptied');
    assert.ok(sim.ext.filter(e => e.store.energy === 100).length >= sim.ext.length - 2, 'lane still fed');
    assert.deepEqual(errors(sim), [], 'flip guard never fired');
});

test('sim: switching the reaction empties and refills the labs, then runs the new one', () => {
    const sim = labRoom({ labs: { reaction: 'KO' } });
    sim.run(1500);
    assert.ok((sim.w.stats.reactions || 0) > 50, 'KO running');
    const config = require('../src/config');
    config.set('labs.reaction', 'OH');
    const switchTick = Game.time;
    sim.w.carryLog = [];
    const before = sim.w.stats.reactions;
    // plan.labs runs every 100 ticks; give it time to switch and refill.
    sim.run(1500);
    const moves = storeMoves(sim.w.carryLog);
    const lab = (id) => sim.labs.find(l => l.id === id);
    const outOfLabs = moves.filter(m => lab(m.from)).map(m => m.r);
    assert.ok(outOfLabs.includes('K') || outOfLabs.includes('O'), 'old reagent emptied');
    assert.ok(moves.some(m => lab(m.to) && m.r === 'H'), 'H brought in');
    assert.ok((sim.storage.store.OH || 0) + sim.labs.reduce((t, l) => t + (l.store.OH || 0), 0) > 0, 'OH made');
    assert.ok(sim.w.stats.reactions > before + 50, 'reactions resumed');
    // No lab got a resource it then gave back after the switch.
    const after = moves.filter(m => m.t > switchTick + 100);
    const bad = [];
    for (const l of sim.labs) {
        const got = new Set(after.filter(m => m.to === l.id).map(m => m.r));
        for (const m of after) if (m.from === l.id && got.has(m.r)) bad.push(`${m.r} lab ${l.id}`);
    }
    assert.deepEqual(bad, [], 'no lab filled and then emptied of the same resource');
    assert.deepEqual(errors(sim), []);
});

test('sim: a boost lab is stocked and left alone', () => {
    const sim = labRoom({ labs: { reaction: 'KO' } });
    const boostLab = sim.labs[5];
    require('../src/config').set('labs.boosts', { XGHO2: boostLab.id });
    sim.run(1500);
    assert.equal(boostLab.store.XGHO2, 1000, `boost lab ${boostLab.store.XGHO2}`);
    sim.w.carryLog = [];
    sim.run(500);
    assert.deepEqual(storeMoves(sim.w.carryLog).filter(m => m.to === boostLab.id || m.from === boostLab.id), [], 'boost lab untouched once stocked');
    assert.ok((sim.w.stats.reactions || 0) > 50, 'reactions run on the other labs');
    assert.deepEqual(errors(sim), []);
});
