'use strict';

/**
 * Terminal (porting P11): the terminal's band stocked by the lane hauler
 * through the logistics matcher (missions/shared/laneHead) and energy
 * balancing between rooms (act.terminal).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createWorld, Store } = require('./helpers/sim');
const { boot } = require('./helpers/runSim');

const ROOT = path.join(__dirname, '..');
function fresh() {
    createWorld({ spawn: [25, 25], sources: [[10, 10]], controller: [40, 40] });
    for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'src'))) delete require.cache[k];
    delete global.__v2heap;
}

const store = (cap, content) => Object.assign(new Store(cap, false), content);

test('balance: richest surplus feeds the deepest deficit, donor stays above target', () => {
    fresh();
    const t = require('../src/services/terminal');
    const fee = (n) => Math.ceil(n * 0.05);
    // Live numbers 2026-10-23 (storage + terminal energy), RCL 8 target 350k.
    const rooms = [
        { name: 'W44S28', energy: 556970, target: 350000, terminalEnergy: 100000 },
        { name: 'W44S29', energy: 278027, target: 350000, terminalEnergy: 2000 },
        { name: 'W43S28', energy: 262429, target: 350000, terminalEnergy: 95160 }
    ];
    assert.deepEqual(t.balance(rooms, 0.1, 10000, fee), { from: 'W44S28', to: 'W43S28', amount: 10000 });
    // Donor just above its band: only the surplus goes.
    rooms[0].energy = 390000;
    assert.deepEqual(t.balance(rooms, 0.1, 10000, fee), { from: 'W44S28', to: 'W43S28', amount: 5000 });
    // Not enough terminal energy for amount + fee: halve until it fits.
    rooms[0].energy = 556970;
    rooms[0].terminalEnergy = 6000;
    assert.deepEqual(t.balance(rooms, 0.1, 10000, fee), { from: 'W44S28', to: 'W43S28', amount: 5000 });
    // Nobody above the band: nothing.
    rooms[0].energy = 380000;
    assert.equal(t.balance(rooms, 0.1, 10000, fee), null);
});

test('act.terminal sends one batch from the donor', () => {
    fresh();
    const proc = require('../src/processes/act/terminal');
    const config = require('../src/config');
    const sends = [];
    const mk = (name, storageE, termE) => ({
        name, controller: { level: 8 },
        storage: { store: store(1000000, { energy: storageE }) },
        terminal: { my: true, cooldown: 0, store: store(300000, { energy: termE }), send: (...a) => { sends.push([name, ...a]); return OK; } }
    });
    const rooms = [mk('W1N1', 500000, 50000), mk('W2N2', 100000, 20000)];
    global.Game.rooms = { W1N1: rooms[0], W2N2: rooms[1] };
    global.Game.market = { calcTransactionCost: (n) => Math.ceil(n * 0.1) };
    const ctx = { config: config.get(), roomList: rooms.map(r => ({ name: r.name, room: r, kind: 'owned' })) };
    proc.run(ctx);
    assert.deepEqual(sends, [['W1N1', 'energy', 10000, 'W2N2', 'balance']]);
    rooms[0].terminal.cooldown = 5;
    sends.length = 0;
    proc.run(ctx);
    assert.deepEqual(sends, [], 'a terminal on cooldown neither sends nor receives');
});

test('sim: the idle lane hauler stocks the terminal next to the head', () => {
    const CORE = { spawn: [24, 20], sources: [[5, 5], [44, 44]], controller: [10, 40] };
    const sim = boot(CORE, {
        deterministic: true,
        config: { construction: { enabled: false }, terminal: { energy: 20000, stock: { X: 3000 } } }
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
    storage.store.energy = 200000;
    storage.store.X = 5000;
    sim.run(1200);
    assert.ok(Object.values(Game.creeps).some(c => c.memory.a === 'laneHauler'), 'lane hauler');
    assert.equal(terminal.store.energy, 20000, `terminal energy ${terminal.store.energy}`);
    assert.ok(Math.abs((terminal.store.X || 0) - 3000) <= 150, `terminal X ${terminal.store.X}`);
    // Over target: the surplus goes back to storage.
    terminal.store.energy = 60000;
    sim.run(200);
    assert.equal(terminal.store.energy, 20000, `drained to ${terminal.store.energy}`);
    assert.deepEqual(sim.logs.filter(l => /ERROR/.test(l)), []);
});
