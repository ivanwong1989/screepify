'use strict';

/**
 * Core lane (porting P4): lane discovery (services/lanes) on layouts shaped
 * like the live rooms, and the lane hauler (missions/coreLane) in the sim.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createWorld } = require('./helpers/sim');
const { boot } = require('./helpers/runSim');

const ROOT = path.join(__dirname, '..');

/** Spawn (24,20) and storage (26,20) share the head tile (25,21). */
const CORE = { spawn: [24, 20], sources: [[5, 5], [44, 44]], controller: [10, 40] };

/**
 * Straight diagonal lane going down-right from the head, extensions packed on
 * both sides (x - y = 2, 3, 5, 6), like the first screenshot.
 * @param {any} world
 */
function diagonal(world) {
    world.addStructure('storage', 26, 20);
    const roads = [];
    for (let i = 0; i <= 11; i++) roads.push(world.addStructure('road', 25 + i, 21 + i));
    const ext = [];
    for (let i = 1; i <= 10; i++) {
        for (const d of [-2, -1, 1, 2]) {
            const x = 25 + i + (d > 0 ? d : 0);
            const y = 21 + i + (d < 0 ? -d : 0);
            ext.push(world.addStructure('extension', x, y));
        }
    }
    return { roads, ext };
}

/**
 * Diamond loop of radius 4 around (25,25), head at its top (25,21), with
 * extensions on the inner and outer rings.
 * @param {any} world
 */
function diamond(world) {
    world.addStructure('storage', 26, 20);
    const ring = (r) => {
        const out = [];
        for (let x = 25 - r; x <= 25 + r; x++) {
            for (let y = 25 - r; y <= 25 + r; y++) if (Math.abs(x - 25) + Math.abs(y - 25) === r) out.push([x, y]);
        }
        return out;
    };
    const roads = ring(4).map(([x, y]) => world.addStructure('road', x, y));
    const ext = [];
    for (const [x, y] of ring(3).concat(ring(5))) {
        if ((x === 24 || x === 26) && y === 20) continue; // spawn, storage
        if (x === 25 && y === 20) continue;
        ext.push(world.addStructure('extension', x, y));
    }
    return { roads, ext };
}

function freshModules() {
    for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'src'))) delete require.cache[k];
    delete global.__v2heap;
}

test('diagonal layout: one straight lane from the head past every extension', () => {
    const world = createWorld(CORE);
    freshModules();
    const { ext } = diagonal(world);
    const lanes = require('../src/services/lanes');
    const job = lanes.discover(world.room);
    assert.ok(job && job.best, 'lane found');
    assert.equal(job.head, 21 * 50 + 25, 'head between spawn and storage');
    assert.equal(job.best.loop, false);
    assert.equal(job.best.covered, ext.length + 1, 'every extension and the spawn');
    const stops = lanes.stops(job.best.path, lanes.targets(world.room));
    const served = Object.values(stops).reduce((n, ids) => n + ids.length, 0);
    assert.equal(served, ext.length + 1);
});

test('diamond layout: the lane closes into a loop', () => {
    const world = createWorld(CORE);
    freshModules();
    const { ext } = diamond(world);
    const lanes = require('../src/services/lanes');
    const job = lanes.discover(world.room);
    assert.ok(job && job.best, 'lane found');
    assert.equal(job.best.loop, true, 'loop');
    assert.equal(new Set(job.best.path).size, job.best.path.length, 'no tile twice');
    assert.ok(job.best.covered >= ext.length, `covered ${job.best.covered}/${ext.length + 1}`);
});

test('CORE_END flag picks the end instead of the automatic search', () => {
    const world = createWorld(CORE);
    freshModules();
    diagonal(world);
    const flag = { name: 'CORE_END', pos: new global.RoomPosition(30, 26, 'W1N1') };
    const find = world.room.find.bind(world.room);
    world.room.find = (type, opts) => (type === global.FIND_FLAGS ? [flag] : find(type, opts));
    const job = require('../src/services/lanes').discover(world.room);
    assert.equal(job.flag, 26 * 50 + 30);
    assert.equal(job.best.path[job.best.path.length - 1], 26 * 50 + 30, 'lane ends at the flag');
});

/**
 * Boots the bot in a room with the diagonal layout, a full storage and RCL 6.
 * @param {(world: any) => any} layout
 */
function bootLane(layout) {
    const sim = boot(CORE, { deterministic: true, config: { construction: { enabled: false } } });
    const built = layout(sim.world);
    sim.world.controller.level = 6;
    sim.world.room.storage.store.energy = 200000;
    // A room that is already running: extensions full when v2 takes over.
    for (const e of built.ext) {
        e.store._cap = 100;
        e.store.energy = 100;
    }
    return Object.assign(sim, built);
}

test('sim: the lane hauler is spawned and keeps the lane filled', () => {
    const sim = bootLane(diagonal);
    sim.run(800);
    const laneHaulers = Object.values(Game.creeps).filter(c => c.memory.a === 'laneHauler');
    assert.equal(laneHaulers.length, 1, 'one lane hauler');
    assert.ok(Memory.rooms.W1N1.ln && Memory.rooms.W1N1.ln.p, 'lane saved');
    const body = laneHaulers[0].body.map(p => p.type);
    assert.ok(body.filter(t => t === 'carry').length >= 2 * body.filter(t => t === 'move').length - 1, 'road body 2:1');
    // Drain every extension, then give the hauler time to refill them.
    for (const e of sim.ext) e.store.energy = 0;
    sim.run(150);
    const full = sim.ext.filter(e => e.store.energy === e.store._cap).length;
    assert.ok(full >= sim.ext.length - 4, `refilled ${full}/${sim.ext.length}`);
    // While it lives, logistics leaves lane targets to it.
    const missions = require('../src/services/cache').store('room.missions').W1N1.list;
    const supply = missions.filter(m => m.id.startsWith('supply:') && sim.ext.some(e => m.targetId === e.id));
    assert.deepEqual(supply.map(m => m.id), [], 'no supply missions for lane extensions');
    assert.deepEqual(sim.logs.filter(l => /ERROR/.test(l)), []);
});

test('sim: loop lane is served in both directions', () => {
    const sim = bootLane(diamond);
    sim.run(800);
    assert.equal(Memory.rooms.W1N1.ln.loop, 1, 'loop saved');
    for (const e of sim.ext) e.store.energy = 0;
    sim.run(150);
    const full = sim.ext.filter(e => e.store.energy === e.store._cap).length;
    assert.ok(full >= sim.ext.length - 4, `refilled ${full}/${sim.ext.length}`);
});

test('sim: an idle lane hauler renews at the spawn next to the head', () => {
    const sim = bootLane(diagonal);
    sim.run(800);
    const hauler = Object.values(Game.creeps).find(c => c.memory.a === 'laneHauler');
    assert.ok(hauler, 'lane hauler');
    hauler.ticksToLive = 900;
    const before = sim.world.stats.renewed || 0;
    // The only spawn may be busy spawning first (it can't renew meanwhile).
    sim.run(250);
    assert.ok((sim.world.stats.renewed || 0) > before, 'renewed');
    assert.ok(hauler.ticksToLive > 900, `ttl ${hauler.ticksToLive}`);
});
