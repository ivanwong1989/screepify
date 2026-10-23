'use strict';

/**
 * Fortify (P7): one mission per room on the weakest wall, gated by room policy
 * and by the size of the backlog (port of v1 mission.fortify).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createWorld } = require('./helpers/sim');
const { DEFAULT_ROOM } = require('./helpers/runSim');

const ROOT = path.join(__dirname, '..');
function fresh() {
    createWorld(DEFAULT_ROOM);
    for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'src'))) delete require.cache[k];
    delete global.__v2heap;
}

/** Walls at RCL 8 (target 5M); `hits` per wall. */
function setupWalls(hits) {
    const objs = {};
    hits.forEach((h, i) => {
        objs[`w${i}`] = { id: `w${i}`, structureType: STRUCTURE_WALL, hits: h, hitsMax: 300000000, pos: { x: i, y: 1, roomName: 'W1N1' } };
    });
    global.Game.getObjectById = (id) => objs[id] || null;
    const scanner = require('../src/services/repairScan');
    scanner.get('W1N1').fortifyIds = Object.keys(objs);
    return objs;
}

/**
 * @param {object} o
 * @param {string} [o.state] policy state
 * @param {number} [o.working] creeps already on fortify:W1N1
 * @param {number} [o.hostiles]
 */
function gen(o = {}) {
    const fortify = require('../src/missions/fortify');
    const out = [];
    fortify.generate({
        rc: { name: 'W1N1', room: { name: 'W1N1', controller: { level: 8 } } },
        intel: { hostiles: new Array(o.hostiles || 0), energySourceIds: [], energyCapacityAvailable: 12900 },
        state: { op: 'NORMAL', economy: 'STOCKPILING' },
        policy: { phase: 'LABS', state: o.state || 'GROW', reasons: [] },
        census: (id) => ({ count: id === 'fortify:W1N1' ? (o.working || 0) : 0, work: 0, carry: 0 })
    }, out);
    return out;
}

test('one mission on the weakest wall, no economy gate', () => {
    fresh();
    setupWalls([4000000, 3600000, 4800000]);
    const out = gen();
    assert.equal(out.length, 1);
    const m = out[0];
    assert.equal(m.id, 'fortify:W1N1');
    assert.equal(m.type, 'fortify');
    assert.equal(m.targetId, 'w1', 'weakest first');
    assert.equal(m.spawn, 'pool');
    assert.deepEqual([m.demand.work, m.demand.minCreeps, m.demand.maxCreeps], [12, 1, 1]);
    assert.equal(m.data.targetHits, 5000000);
});

test('backlog gate: no new fortifier for a small deficit, but a working one finishes', () => {
    fresh();
    // 12 WORK × 100 × 150 = 180k needed; 100k missing.
    setupWalls([4950000, 4950000]);
    assert.equal(gen().length, 0, 'gate closed');
    const kept = gen({ working: 1 });
    assert.equal(kept.length, 1, 'existing fortifier keeps going');
    assert.equal(kept[0].spawn, false, 'but no new spawn');
});

test('policy gate and hostiles', () => {
    fresh();
    setupWalls([1000000]);
    assert.equal(gen({ state: 'STOCKPILE' }).length, 0);
    assert.equal(gen({ state: 'CRITICAL' }).length, 0);
    const rec = gen({ state: 'RECOVER', working: 1 });
    assert.equal(rec[0].spawn, false, 'RECOVER keeps existing fortifiers only');
    const def = gen({ state: 'DEFENSIVE', hostiles: 2 });
    assert.deepEqual([def[0].demand.minCreeps, def[0].demand.maxCreeps], [2, 2], 'two under attack');
});

test('critical walls stay with repair, done walls are skipped', () => {
    fresh();
    setupWalls([3000, 5000000]);
    assert.equal(gen().length, 0);
});

test('worker moves on to the next wall when its target is done', () => {
    fresh();
    const objs = setupWalls([3600000, 4000000]);
    const fortify = require('../src/missions/fortify');
    const m = gen()[0];
    objs.w0.hits = 5000000;
    const creep = { name: 'f1', memory: { s: 'working' }, store: { energy: 50, getCapacity: () => 50, getUsedCapacity: () => 50, getFreeCapacity: () => 0 }, pos: { x: 25, y: 25, roomName: 'W1N1' } };
    const room = { name: 'W1N1', controller: { level: 8 }, find: () => [], lookForAt: () => [] };
    creep.room = room;
    const rc = { name: 'W1N1', room };
    const task = fortify.nextTask(creep, m, rc, /** @type {any} */ ({}));
    assert.deepEqual(task, { a: 'repair', i: 'w1' });
    assert.equal(m.data.cur, 'w1');
    assert.equal(m.targetId, 'w0', 'planner-owned field untouched');
});
