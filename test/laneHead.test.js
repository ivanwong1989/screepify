'use strict';

/**
 * Core lane hauler at the head through the logistics matcher (LOGISTICS.md
 * step L2), in the simulator. A ping-pong between piles keeps the hauler busy
 * while nothing reaches the extensions, so these tests check both:
 * - no store flips between giving and receiving without an outside cause;
 * - the lane keeps being refilled while the terminal is being worked.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/runSim');

const CORE = { spawn: [24, 20], sources: [[5, 5], [44, 44]], controller: [10, 40] };

/**
 * RCL 6 room: spawn (24,20), storage (26,20), terminal (24,21) around the head
 * (25,21), a straight diagonal lane with 20 extensions along it.
 * @param {object} [config]
 */
function core(config) {
    const sim = boot(CORE, {
        deterministic: true,
        config: Object.assign({ construction: { enabled: false }, terminal: { energy: 20000, energyMargin: 2000, stock: { X: 3000 } } }, config || {})
    });
    const w = sim.world;
    const storage = w.addStructure('storage', 26, 20);
    const terminal = w.addStructure('terminal', 24, 21);
    for (let i = 0; i <= 11; i++) w.addStructure('road', 25 + i, 21 + i);
    const ext = [];
    for (let i = 1; i <= 10; i++) for (const d of [-1, 1]) ext.push(w.addStructure('extension', 25 + i + (d > 0 ? 1 : 0), 21 + i + (d < 0 ? 1 : 0)));
    w.controller.level = 6;
    for (const e of ext) {
        e.store._cap = 100;
        e.store.energy = 100;
    }
    storage.store.energy = 300000;
    storage.store.X = 5000;
    terminal.store.energy = 20000;
    terminal.store.X = 3000;
    sim.run(800);
    const hauler = () => Object.values(Game.creeps).find(c => c.memory.a === 'laneHauler');
    assert.ok(hauler(), 'lane hauler up');
    w.carryLog = [];
    return Object.assign(sim, { w, storage, terminal, ext, hauler });
}

/** Lane hauler moves at one store: +n in, −n out. */
function laneMoves(sim, id, res) {
    const name = sim.hauler().name;
    return sim.w.carryLog.filter(e => e.creep === name && e.id === id && (!res || e.r === res))
        .map(e => ({ t: e.t, dir: e.a === 'transfer' ? 'in' : 'out', n: e.n, r: e.r }));
}

/**
 * Per resource at one store: a change of direction (gave, then received, or
 * the reverse) with no outside change to that store in between.
 * @param {{t: number, dir: string, r: string}[]} moves
 * @param {number[]} outside  ticks the test changed the store itself
 */
function flips(moves, outside) {
    const last = {};
    const out = [];
    for (const m of moves) {
        const prev = last[m.r];
        if (prev && prev.dir !== m.dir && !outside.some(t => t > prev.t && t <= m.t)) out.push(`${m.r}: ${prev.dir}@${prev.t} → ${m.dir}@${m.t}`);
        last[m.r] = m;
    }
    return out;
}

const errors = (sim) => sim.logs.filter(l => /ERROR/.test(l));

test('fills the terminal to exactly its target, in full loads, then stays still', () => {
    const sim = core();
    sim.terminal.store.energy = 0;
    sim.run(200);
    assert.equal(sim.terminal.store.energy, 20000, `terminal ${sim.terminal.store.energy}`);
    const ins = laneMoves(sim, sim.terminal.id, 'energy');
    const cap = sim.hauler().store.getCapacity();
    assert.ok(ins.every(m => m.dir === 'in'), 'only filling');
    assert.ok(ins.length <= Math.ceil(20000 / cap) + 1, `${ins.length} loads for 20000 with ${cap} carry`);
    sim.w.carryLog = [];
    sim.run(300);
    assert.deepEqual(laneMoves(sim, sim.terminal.id), [], 'nothing moves at target');
    assert.deepEqual(errors(sim), []);
});

test('drains a full terminal to its target, then stays still', () => {
    const sim = core();
    sim.terminal.store.energy = 60000;
    sim.run(250);
    assert.equal(sim.terminal.store.energy, 20000, `terminal ${sim.terminal.store.energy}`);
    assert.ok(laneMoves(sim, sim.terminal.id, 'energy').every(m => m.dir === 'out'), 'only draining');
    sim.w.carryLog = [];
    sim.run(300);
    assert.deepEqual(laneMoves(sim, sim.terminal.id), []);
});

test('inside the band nothing moves', () => {
    for (const e of [18500, 21500]) {
        const sim = core();
        sim.terminal.store.energy = e;
        sim.terminal.store.X = 3100;
        sim.run(300);
        assert.deepEqual(laneMoves(sim, sim.terminal.id), [], `terminal at ${e}`);
        assert.equal(sim.terminal.store.energy, e);
    }
});

test('a committed load is delivered even when the lane suddenly needs energy', () => {
    const sim = core();
    sim.terminal.store.X = 0;
    // Run until the hauler has picked up X for the terminal.
    let picked = false;
    for (let i = 0; i < 100 && !picked; i++) {
        sim.run(1);
        picked = (sim.hauler().store.X || 0) > 0;
    }
    assert.ok(picked, 'hauler picked up X for the terminal');
    for (const e of sim.ext) e.store.energy = 0; // spawning empties the lane
    sim.w.carryLog = [];
    sim.run(5);
    const xMoves = sim.w.carryLog.filter(e => e.r === 'X');
    assert.ok(xMoves.length >= 1 && xMoves[0].a === 'transfer' && xMoves[0].id === sim.terminal.id,
        `X went to the terminal, not back to storage: ${JSON.stringify(xMoves)}`);
    sim.run(150);
    assert.ok(sim.ext.filter(e => e.store.energy === 100).length >= sim.ext.length - 2, 'lane refilled after');
});

test('storage full: leftovers overflow into the terminal without a loop', () => {
    const sim = core();
    sim.storage.store._cap = sim.storage.store.getUsedCapacity();
    sim.terminal.store.energy = 21000;
    for (const e of sim.ext) e.store.energy = 0;
    sim.run(400);
    const moves = laneMoves(sim, sim.terminal.id, 'energy');
    assert.deepEqual(flips(moves, []), [], 'no flip at the terminal');
    assert.deepEqual(errors(sim), []);
});

test('soak: 6000 ticks of spawning and terminal sends: no ping-pong, the lane keeps being fed', () => {
    const sim = core();
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const outside = [];
    const refill = [];
    let pending = null;
    for (let t = 0; t < 6000; t++) {
        if (t % 37 === 0) {
            for (const e of sim.ext) if (rand() < 0.5) e.store.energy = 0;
            if (!pending) pending = Game.time;
        }
        if (t % 150 === 75) {
            const k = rand();
            if (k < 0.35) sim.terminal.store.energy = Math.max(0, sim.terminal.store.energy - 11000);
            else if (k < 0.7) sim.terminal.store.energy += 10000;
            else sim.terminal.store.X = Math.max(0, sim.terminal.store.X + (rand() < 0.5 ? -1000 : 1000));
            outside.push(Game.time); // the bot sees it this tick; moves are logged at this tick too
        }
        sim.run(1);
        if (pending && sim.ext.every(e => e.store.energy === 100)) {
            refill.push(Game.time - pending);
            pending = null;
        }
    }
    const moves = laneMoves(sim, sim.terminal.id);
    assert.ok(moves.length > 20, `terminal was worked (${moves.length} moves)`);
    assert.deepEqual(flips(moves, outside), [], 'no flip without an outside change');
    assert.ok(refill.length > 100, `lane refilled ${refill.length} times`);
    const worst = Math.max(...refill);
    const avg = refill.reduce((a, b) => a + b, 0) / refill.length;
    assert.ok(worst <= 120 && avg <= 45, `refill time avg ${avg.toFixed(1)}, worst ${worst}`);
    assert.deepEqual(errors(sim), [], 'flip guard never fired');
});

test('flip guard: a planted v1-style loop is cut off and the lane still gets fed', () => {
    const sim = core();
    // Plant the bug: the matcher shuttles energy storage ↔ terminal forever.
    const matcher = require('../src/services/matcher');
    const pick = matcher.pick;
    let flip = false;
    matcher.pick = (reqs, o) => {
        if (!o.to || !o.to.has(sim.terminal.id)) return pick(reqs, o);
        flip = !flip;
        const [f, d] = flip ? [sim.storage.id, sim.terminal.id] : [sim.terminal.id, sim.storage.id];
        // Respect the blocked list like the real request list does.
        const e = require('../src/services/cache').store('logistics.requests').W1N1;
        if (!e || !Object.values(e.reqs.byRes).some(x => x.req.concat(x.off).some(y => y.id === sim.terminal.id))) {
            if (require('../src/services/flipGuard').blocked('W1N1').has(`${sim.terminal.id}:energy`)) return null;
        }
        return { r: 'energy', q: 1000, f, d, s: 'p' };
    };
    try {
        sim.run(200);
        assert.ok(errors(sim).some(l => /flipped in\/out/.test(l)), 'flip guard fired');
        const blockedAt = sim.w.carryLog.filter(e => e.id === sim.terminal.id).length;
        sim.w.carryLog = [];
        for (const e of sim.ext) e.store.energy = 0;
        sim.run(150);
        assert.ok(laneMoves(sim, sim.terminal.id).length < 3, `shuttling stopped (was ${blockedAt} moves)`);
        assert.ok(sim.ext.filter(e => e.store.energy === 100).length >= sim.ext.length - 2, 'lane fed despite the bug');
    } finally {
        matcher.pick = pick;
    }
});
