'use strict';

/**
 * Smoke test of the real bundle: build dist/main.js, load it the way the game
 * does (one module, globals provided), and run a simulated colony.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../scripts/build');
const { boot } = require('./helpers/runSim');

test('bundle boots a colony: migrates Memory, spawns, exports stats', async () => {
    await build();
    const sim = boot(undefined, { bundle: true, deterministic: true });
    global.Memory.military = { stale: true };
    sim.run(400);

    assert.equal(global.Memory.v, 2);
    assert.equal(global.Memory.military, undefined);
    assert.ok(sim.world.stats.spawned.length > 0, 'spawned creeps');
    assert.ok(sim.world.segStore && sim.world.segStore[90], 'stats segment written');
    assert.equal(typeof global.stats, 'function', 'console commands registered');
    assert.match(global.stats(), /CPU avg/);
    assert.match(global.proc.list(), /act\.creeps/);
    assert.deepEqual(sim.logs.filter(l => /ERROR/.test(l)), []);
});
