'use strict';

/**
 * Whole-economy flow (docs/v2/LOGISTICS.md step L3), in the simulator: real
 * spawning, miners, mining haulers, upgraders, the lane hauler, the mineral
 * miner, a controller container, a spare container and a terminal with stock
 * targets. Every withdraw → next transfer by the same creep is a move between
 * stores. No store other than storage may give a resource away and then
 * receive it (or the reverse) without an outside change; energy taken to be
 * used (upgrading, building) is not a move.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/runSim');

const CORE = { spawn: [24, 20], sources: [[5, 5], [44, 44]], controller: [10, 40] };

/**
 * @param {{spec?: object, mining?: [number, number][], config?: object}} [o]
 *   mining: container positions next to the sources
 */
function room(o) {
    const opt = o || {};
    const sim = boot(opt.spec || CORE, {
        deterministic: true,
        config: {
            ...(opt.config || {}),
            construction: { enabled: false },
            terminal: { energy: 20000, energyMargin: 2000, stock: { X: 3000, O: 2000 } },
            minerals: { maxStock: 1000000 }
        }
    });
    const w = sim.world;
    const storage = w.addStructure('storage', 26, 20);
    const terminal = w.addStructure('terminal', 24, 21);
    for (let i = 0; i <= 11; i++) w.addStructure('road', 25 + i, 21 + i);
    const ext = [];
    for (let i = 1; i <= 10; i++) for (const d of [-1, 1]) ext.push(w.addStructure('extension', 25 + i + (d > 0 ? 1 : 0), 21 + i + (d < 0 ? 1 : 0)));
    const mining = (opt.mining || [[6, 6], [43, 43]]).map(([x, y]) => w.addStructure('container', x, y));
    const ctrl = w.addStructure('container', 11, 39);
    const spare = w.addStructure('container', 20, 15);
    spare.store.energy = 1500;
    w.addMineral(35, 28, 'O', 60000, true);
    w.controller.level = 6;
    for (const e of ext) {
        e.store._cap = 100;
        e.store.energy = 100;
    }
    storage.store.energy = 300000; // above the RCL 6 stockpile target, so the room is in GROW and upgrades
    storage.store.X = 5000;
    terminal.store.energy = 20000;
    w.carryLog = [];
    return Object.assign(sim, { w, storage, terminal, ext, mining, ctrl, spare });
}

/**
 * Moves between stores from the carry log: each creep's transfer into a store
 * comes from the store it last withdrew that resource from (null: it never
 * withdrew any, so it harvested or picked it up).
 */
function storeMoves(log) {
    const lastSrc = {};
    const moves = [];
    for (const e of log) {
        const k = `${e.creep}:${e.r}`;
        if (e.a === 'withdraw') lastSrc[k] = e.id;
        else moves.push({ t: e.t, r: e.r, from: lastSrc[k] || null, to: e.id });
    }
    return moves;
}

/**
 * Per (store, resource): direction changes without an outside change at that
 * store. A delivery with no store behind it (harvested, picked up) is inflow
 * from outside, like a terminal receipt.
 */
function flips(moves, bufferId, outside) {
    const last = {};
    const out = [];
    const see = (id, r, dir, t) => {
        if (!id || id === bufferId) return;
        const k = `${id}:${r}`;
        const p = last[k];
        if (p && p.dir !== dir && !(outside[id] || []).some(x => x > p.t && x <= t)) out.push(`${r} ${id}: ${p.dir}@${p.t} → ${dir}@${t}`);
        last[k] = { dir, t };
    };
    for (const m of moves) {
        if (!m.from) {
            (outside[m.to] || (outside[m.to] = [])).push(m.t);
            continue;
        }
        see(m.from, m.r, 'out', m.t);
        see(m.to, m.r, 'in', m.t);
    }
    return out;
}

/** Runs 6000 ticks with terminal events; returns the moves and the flips. */
function soak(sim) {
    const outside = { [sim.terminal.id]: [] };
    let seed = 11;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const upgraded0 = sim.w.stats.upgraded || 0;
    for (let t = 0; t < 6000; t++) {
        if (t % 150 === 75) {
            const k = rand();
            if (k < 0.35) sim.terminal.store.energy = Math.max(0, sim.terminal.store.energy - 11000);
            else if (k < 0.7) sim.terminal.store.energy += 10000;
            else sim.terminal.store.X = Math.max(0, (sim.terminal.store.X || 0) + (rand() < 0.5 ? -1000 : 1000));
            outside[sim.terminal.id].push(Game.time);
        }
        sim.run(1);
    }
    const moves = storeMoves(sim.w.carryLog);
    return { moves, bad: flips(moves, sim.storage.id, outside), upgraded: (sim.w.stats.upgraded || 0) - upgraded0 };
}

test('soak: 6000 ticks of the whole economy, no store passes resources back and forth', () => {
    const sim = room();
    const { moves, bad, upgraded } = soak(sim);
    assert.deepEqual(bad, [], 'no store flips without an outside change');

    // The economy actually ran.
    const intoTerminal = moves.filter(m => m.to === sim.terminal.id);
    assert.ok(intoTerminal.some(m => m.r === 'O'), 'mined O reached the terminal stock target');
    assert.ok(upgraded > 5000, `upgraded ${upgraded}`);
    assert.ok(moves.filter(m => sim.mining.some(c => c.id === m.from)).length > 100, 'mining containers hauled');
    // The spare container is emptied into storage and never refilled.
    assert.ok(moves.some(m => m.from === sim.spare.id), 'spare container drained');
    assert.deepEqual(moves.filter(m => m.to === sim.spare.id).map(m => m.t), [], 'spare container never refilled');
    assert.deepEqual(sim.logs.filter(l => /ERROR/.test(l)), [], 'no errors, flip guard never fired');
});

test('soak: fleet hauling (no mining lanes), controller container next to a source', () => {
    // Source at (12,44) with its container at (13,43); the controller container
    // at (11,39) is the closest sink, so fleet routes fill it. Nothing may
    // take that energy back out to another store.
    const sim = room({
        spec: { spawn: [24, 20], sources: [[5, 5], [12, 44]], controller: [10, 40] },
        mining: [[6, 6], [13, 43]],
        config: { lanes: { mining: false } }
    });
    sim.ctrl.store.energy = 0;
    const { moves, bad } = soak(sim);
    assert.ok(moves.filter(m => m.to === sim.ctrl.id && m.from).length >= 2, 'fleet filled the controller container');
    assert.deepEqual(bad, [], 'no store flips without an outside change');
    assert.deepEqual(sim.logs.filter(l => /ERROR/.test(l)), []);
});

test('non-energy cargo goes where the request list says (a terminal that asks for it, else storage)', () => {
    const { createWorld } = require('./helpers/sim');
    const w = createWorld(CORE);
    for (const k of Object.keys(require.cache)) if (k.includes('/src/')) delete require.cache[k];
    const storage = w.addStructure('storage', 26, 20);
    const terminal = w.addStructure('terminal', 24, 21);
    const requests = require('../src/services/requests');
    const ledger = require('../src/services/ledger');
    const transfer = require('../src/missions/transfer');
    const { Store } = require('./helpers/sim');
    const term = (stock) => ({ energy: 20000, energyMargin: 2000, stock, flushUntargeted: false, rooms: {} });
    const creep = { name: 'c1', room: w.room, pos: new RoomPosition(25, 21, 'W1N1'), memory: {}, store: Object.assign(new Store(500), { energy: 0, X: 300 }) };
    const mission = { id: 'supply:x', type: 'transfer', data: { mode: 'supply' } };
    terminal.store.energy = 20000;
    const run = (stock, x) => {
        terminal.store.X = x;
        const reqs = requests.build([storage, terminal], ledger.build([]), { terminal: term(stock), roomName: 'W1N1', miningContainers: new Set() });
        return transfer.nextTask(creep, mission, { name: 'W1N1', room: w.room, requests: reqs });
    };
    assert.deepEqual(run({ X: 3000 }, 0), { a: 'transfer', i: terminal.id, r: 'X' }, 'terminal wants X');
    assert.deepEqual(run({ X: 3000 }, 3000), { a: 'transfer', i: storage.id, r: 'X' }, 'terminal at target: storage');
    assert.deepEqual(run({}, 0), { a: 'transfer', i: storage.id, r: 'X' }, 'no target: storage');
});
