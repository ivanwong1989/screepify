'use strict';

/**
 * Mining lanes (porting P5): path rules, link mode, and the haulers taking
 * over source containers from the fleet in the sim.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createWorld } = require('./helpers/sim');
const { boot } = require('./helpers/runSim');

const ROOT = path.join(__dirname, '..');
const ROOM = { spawn: [24, 20], sources: [[8, 10], [40, 38]], controller: [10, 40] };

function freshModules() {
    for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'src'))) delete require.cache[k];
    delete global.__v2heap;
}

/** Storage next to the spawn, a container at each source. @param {any} world */
function base(world) {
    const storage = world.addStructure('storage', 26, 20);
    const c1 = world.addStructure('container', 9, 11);
    const c2 = world.addStructure('container', 39, 37);
    return { storage, containers: [c1, c2] };
}

test('mining lane path: container to storage, never through tiles next to a source', () => {
    const world = createWorld(ROOM);
    freshModules();
    const { storage, containers } = base(world);
    const miningLane = require('../src/missions/miningLane');
    const lane = miningLane.lanePath(world.room, containers[0].pos, storage.pos, 'a');
    assert.ok(lane && lane.path.length > 5, 'path found');
    const last = lane.path[lane.path.length - 1];
    assert.ok(Math.max(Math.abs(last % 50 - 26), Math.abs(Math.floor(last / 50) - 20)) <= 1, 'ends next to storage');
    for (const p of lane.path) {
        const x = p % 50;
        const y = Math.floor(p / 50);
        for (const s of world.sources) {
            assert.ok(Math.max(Math.abs(x - s.pos.x), Math.abs(y - s.pos.y)) > 1, `${x},${y} is next to a source`);
        }
    }
    // Cached until something changes.
    assert.equal(miningLane.lanePath(world.room, containers[0].pos, storage.pos, 'a'), lane);
});

test('link source: one hauler stationed between container and link', () => {
    const world = createWorld(ROOM);
    freshModules();
    const { containers } = base(world);
    const srcLink = world.addStructure('link', 10, 12);
    world.addStructure('link', 27, 21); // receiver near storage
    const intel = require('../src/processes/sense/intel').gather(world.room);
    const miningLane = require('../src/missions/miningLane');
    const src = intel.sources.find(s => s.pos.x === 8);
    assert.equal(miningLane.sourceLink(world.room, src, intel), srcLink);
    const st = miningLane.station(world.room, containers[0].pos, srcLink.pos);
    const x = st % 50;
    const y = Math.floor(st / 50);
    assert.ok(Math.max(Math.abs(x - 9), Math.abs(y - 11)) <= 1 && Math.max(Math.abs(x - 10), Math.abs(y - 12)) <= 1,
        `station ${x},${y} touches container and link`);
});

test('sim: mining haulers take over the source containers from the fleet', () => {
    const sim = boot(ROOM, { deterministic: true, config: { construction: { enabled: false } } });
    const { storage, containers } = base(sim.world);
    for (let x = 12; x <= 23; x++) sim.world.addStructure('road', x, 12 + Math.floor((x - 12) * 8 / 11));
    sim.world.controller.level = 4;
    storage.store.energy = 20000;
    sim.run(1500);
    const missions = require('../src/services/cache').store('room.missions').W1N1.list;
    const lanes = missions.filter(m => m.type === 'miningLane');
    assert.equal(lanes.length, 2, 'one mining lane per source');
    const haulers = Object.values(Game.creeps).filter(c => c.memory.a === 'miningHauler');
    assert.ok(haulers.length >= 2 && haulers.length <= 6, `mining haulers ${haulers.length}`);
    // The fleet no longer hauls from covered containers.
    const routes = missions.filter(m => containers.some(c => m.id.startsWith(`haul:${c.id}:`)));
    assert.deepEqual(routes.map(m => m.id), [], 'no fleet mining routes');
    // Energy keeps flowing: containers don't overflow and storage grows.
    const before = storage.store.energy;
    sim.run(500);
    assert.ok(storage.store.energy > before, `storage ${before} -> ${storage.store.energy}`);
    for (const c of containers) assert.ok(c.store.energy < 2000, `container ${c.store.energy}`);
    assert.deepEqual(sim.logs.filter(l => /ERROR/.test(l)), []);
});
