'use strict';

/**
 * End-to-end economy tests in the simulator (test/helpers/sim.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/runSim');

/** @param {string} a */
const count = (a) => Object.values(Game.creeps).filter(c => c.memory.a === a).length;

test('fresh room bootstraps: miners → haulers → workers, RCL 2, extensions placed', () => {
    const sim = boot(undefined, { deterministic: true });
    sim.run(3000);
    const w = sim.world;
    assert.deepEqual(sim.logs.filter(l => /ERROR/.test(l)), []);
    assert.ok(w.controller.level >= 2, `rcl ${w.controller.level}`);
    assert.ok(count('miner') >= 2, 'miners');
    assert.ok(count('hauler') >= 2, 'haulers');
    assert.ok(count('worker') >= 1, 'workers');
    const extensions = w.structures.filter(s => s.structureType === 'extension').length +
        w.sites.filter(s => s.structureType === 'extension').length;
    assert.ok(extensions >= 5, `extensions built or placed: ${extensions}`);
    assert.equal(w.stats.spawned[0].name.split('_')[0], 'miner', 'first spawn is a miner (v1 order)');
});

test('without construction the creep mix matches v1 (≈10 miners, 3 haulers, 15 workers)', () => {
    const sim = boot(undefined, { deterministic: true, config: { construction: { enabled: false } } });
    sim.run(2500);
    assert.deepEqual(sim.logs.filter(l => /ERROR/.test(l)), []);
    assert.ok(count('miner') >= 8, `miners ${count('miner')}`);
    assert.ok(count('hauler') >= 2 && count('hauler') <= 4, `haulers ${count('hauler')}`);
    assert.ok(count('worker') >= 12, `workers ${count('worker')}`);
    assert.ok(sim.world.stats.upgraded > 8000, `upgraded ${sim.world.stats.upgraded}`);
});
