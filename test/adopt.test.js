'use strict';

/**
 * Adopting creeps without v2 memory (sense.adopt) and binding them to spawn
 * slots (act.spawns bindStrays), as after the v1 → v2 Memory wipe.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/runSim');

test('body → archetype follows the v1 recipes', () => {
    boot(undefined, { deterministic: true });
    const { archetype } = require('../src/processes/sense/adopt');
    const b = (work, carry, move, other = 0) => archetype({ work, carry, move, other });
    assert.equal(b(5, 1, 1), 'miner', 'static miner');
    assert.equal(b(3, 3, 6), 'miner', 'mobile miner');
    assert.equal(b(4, 4, 4), 'worker');
    assert.equal(b(1, 1, 1), 'worker', 'smallest worker (miners have ≥ 2 WORK)');
    assert.equal(b(0, 22, 11), 'laneHauler', 'road body');
    assert.equal(b(0, 10, 10), 'hauler');
    assert.equal(b(0, 0, 1), null, 'scout left alone');
    assert.equal(b(0, 0, 5, 5), null, 'military left alone');
});

/**
 * Runs 2000 ticks, optionally wipes Memory like the v1 → v2 switch, runs 200 more.
 * @param {boolean} wipe
 */
function run(wipe) {
    const sim = boot(undefined, { deterministic: true, config: { construction: { enabled: false } } });
    sim.run(2000);
    const before = Object.keys(Game.creeps).length;
    const spawnedBefore = sim.world.stats.spawned.length;
    const upgradedBefore = sim.world.stats.upgraded;
    if (wipe) {
        for (const k of Object.keys(Memory)) if (k !== 'config') delete Memory[k];
        Memory.creeps = {};
    }
    sim.run(5);
    const mine = Object.values(Game.creeps).filter(c => !c.spawning);
    const adopted = mine.filter(c => c.memory.h === 'W1N1' && c.memory.a).length;
    const minersWorking = mine.filter(c => c.memory.a === 'miner').every(c => c.memory.m);
    sim.run(195);
    return {
        sim, before, adopted, minersWorking,
        spawned: sim.world.stats.spawned.length - spawnedBefore,
        upgraded: sim.world.stats.upgraded - upgradedBefore
    };
}

test('sim: after a Memory wipe the same creeps go back to work, no extra spawns', () => {
    const base = run(false);
    const wiped = run(true);
    assert.ok(wiped.adopted >= wiped.before - 3, `adopted ${wiped.adopted}/${wiped.before}`);
    assert.ok(wiped.minersWorking, 'miners back on harvest missions');
    assert.ok(wiped.spawned <= base.spawned + 1, `spawned ${wiped.spawned} (no wipe: ${base.spawned})`);
    assert.ok(wiped.upgraded >= base.upgraded * 0.8, `upgraded ${wiped.upgraded} (no wipe: ${base.upgraded})`);
    assert.deepEqual(wiped.sim.logs.filter(l => /ERROR/.test(l)), []);
});
