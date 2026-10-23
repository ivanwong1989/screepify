'use strict';

/**
 * Towers: defending (attack), healing, and being refilled, in the sim with a
 * core lane room like the live ones.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/runSim');

const CORE = { spawn: [24, 20], sources: [[5, 5], [44, 44]], controller: [10, 40] };

/**
 * Diagonal core lane room at RCL 6 with full storage and extensions, one tower
 * next to the lane (28,23) and one away from it (20,30).
 */
function room() {
    const sim = boot(CORE, { deterministic: true, config: { construction: { enabled: false } } });
    const w = sim.world;
    w.addStructure('storage', 26, 20);
    for (let i = 0; i <= 11; i++) w.addStructure('road', 25 + i, 21 + i);
    const ext = [];
    for (let i = 3; i <= 10; i++) {
        for (const d of [-2, -1, 1, 2]) ext.push(w.addStructure('extension', 25 + i + (d > 0 ? d : 0), 21 + i + (d < 0 ? -d : 0)));
    }
    const laneTower = w.addStructure('tower', 28, 23);
    const farTower = w.addStructure('tower', 20, 30);
    w.controller.level = 6;
    w.room.storage.store.energy = 200000;
    for (const e of ext) {
        e.store._cap = 100;
        e.store.energy = 100;
    }
    laneTower.store.energy = 1000;
    farTower.store.energy = 1000;
    return { sim, w, laneTower, farTower };
}

test('sim: an invader is shot the tick it shows up and killed', () => {
    const { sim, w, laneTower, farTower } = room();
    sim.run(600);
    const before = w.stats.towerActions || 0;
    const invader = w.addHostile(30, 30, ['attack', 'attack', 'move', 'move', 'move', 'move', 'move', 'move', 'move', 'move']);
    sim.run(1);
    assert.ok((w.stats.towerActions || 0) - before >= 2, 'both towers fired on the first tick');
    assert.ok(invader.hits < invader.hitsMax, 'hit');
    sim.run(5);
    assert.equal(w.stats.killed, 1, 'killed');
    assert.ok(laneTower.store.energy < 1000 || farTower.store.energy < 1000, 'towers spent energy');
    assert.deepEqual(sim.logs.filter(l => /ERROR/.test(l)), []);
});

test('sim: policy turns DEFENSIVE while an armed invader is in the room', () => {
    const { sim, w } = room();
    sim.run(600);
    // Tough enough to survive a few ticks so the policy can see it.
    w.addHostile(30, 30, Array(20).fill('tough').concat(['attack', 'move']));
    sim.run(2);
    const cache = require('../src/services/cache');
    assert.equal(cache.store('policy.last').W1N1.state, 'DEFENSIVE');
});

test('sim: towers heal my damaged creeps', () => {
    const { sim } = room();
    sim.run(600);
    const creep = Object.values(Game.creeps).find(c => !c.spawning);
    creep.hits = Math.floor(creep.hitsMax / 3);
    const start = creep.hits;
    sim.run(1);
    assert.ok(creep.hits > start, 'healing starts at once');
    // Far from the towers heal drops to ~100 per tower per tick.
    sim.run(20);
    assert.equal(creep.hits, creep.hitsMax, 'healed to full');
});

test('sim: drained towers are refilled, on the lane and off it', () => {
    const { sim, laneTower, farTower } = room();
    sim.run(600);
    laneTower.store.energy = 0;
    farTower.store.energy = 0;
    sim.run(150);
    assert.ok(laneTower.store.energy >= 900, `lane tower ${laneTower.store.energy}`);
    assert.ok(farTower.store.energy >= 900, `off-lane tower ${farTower.store.energy}`);
});

test('sim: in a long fight the towers are kept supplied', () => {
    const { sim, w, laneTower, farTower } = room();
    sim.run(600);
    const tank = w.addHostile(30, 30, Array(20).fill('tough').concat(['attack', 'move']));
    let lowest = Infinity;
    let fired = 0;
    for (let i = 0; i < 300; i++) {
        tank.hits = tank.hitsMax; // never dies: towers fire every tick
        const a = w.stats.towerActions || 0;
        sim.run(1);
        fired += (w.stats.towerActions || 0) - a;
        lowest = Math.min(lowest, laneTower.store.energy, farTower.store.energy);
    }
    assert.ok(fired >= 580, `tower shots ${fired}/600`);
    assert.ok(lowest >= 100, `lowest tower energy ${lowest}`);
    if (process.env.SHOW) console.log(`fight: shots ${fired}, lowest tower energy ${lowest}`);
});
