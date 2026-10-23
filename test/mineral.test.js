'use strict';

/**
 * Minerals (porting P10): one miner per mineral with an extractor, loads to
 * storage, stopped by the stock cap and by room policy.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/runSim');

const ROOM = { spawn: [24, 20], sources: [[5, 5], [44, 44]], controller: [10, 40] };

/** RCL 6 room with storage, a mineral with an extractor, policy forced to GROW. */
function bootMineral(config) {
    const sim = boot(ROOM, { deterministic: true, config: Object.assign({ construction: { enabled: false } }, config || {}) });
    const w = sim.world;
    w.controller.level = 6;
    const storage = w.addStructure('storage', 26, 20);
    storage.store.energy = 200000;
    const mineral = w.addMineral(35, 30, 'O', 60000, true);
    (Memory.rooms.W1N1 || (Memory.rooms.W1N1 = {})).po = 'GROW';
    return Object.assign(sim, { storage, mineral });
}

const missionIds = () => require('../src/services/cache').store('room.missions').W1N1.list.map(m => m.id);

test('sim: a mineral miner mines and fills storage', () => {
    const sim = bootMineral();
    sim.run(1500);
    const miners = Object.values(Game.creeps).filter(c => c.memory.a === 'mineralMiner');
    assert.equal(miners.length, 1, 'one mineral miner');
    assert.ok(missionIds().includes(`mineral:${sim.mineral.id}`));
    assert.ok((sim.storage.store.O || 0) > 0, `storage O ${sim.storage.store.O}`);
    assert.equal(sim.mineral.mineralAmount + (sim.storage.store.O || 0) + (miners[0].store.O || 0), 60000, 'nothing lost');
    assert.deepEqual(sim.logs.filter(l => /ERROR/.test(l)), []);
});

test('sim: no mining at the stock cap, while RECOVER, or without an extractor', () => {
    const sim = bootMineral({ minerals: { maxStock: 50000 } });
    sim.storage.store.O = 50000;
    sim.run(100);
    assert.ok(!missionIds().some(id => id.startsWith('mineral:')), 'stock cap');

    sim.storage.store.O = 0;
    Memory.rooms.W1N1.po = 'RECOVER';
    sim.run(100);
    assert.ok(!missionIds().some(id => id.startsWith('mineral:')), 'RECOVER');

    Memory.rooms.W1N1.po = 'GROW';
    sim.run(100);
    assert.ok(missionIds().includes(`mineral:${sim.mineral.id}`), 'back on');

    const noExtractor = bootMineral();
    noExtractor.world.minerals.length = 0;
    noExtractor.world.addMineral(35, 30, 'H', 60000, false);
    noExtractor.run(100);
    assert.ok(!missionIds().some(id => id.startsWith('mineral:')), 'no extractor');
});
