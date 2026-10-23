'use strict';

/**
 * Traffic (services/traffic + act.traffic): creeps in the way are swapped or
 * shoved instead of blocking a one-tile lane.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createWorld } = require('./helpers/sim');

const ROOT = path.join(__dirname, '..');

/** A room that is all wall except a 1-wide lane on y=25 and a pocket for spawn/sources/controller. */
function corridorWorld() {
    const open = new Set();
    for (let x = 2; x <= 47; x++) open.add(25 * 50 + x);
    for (let y = 40; y <= 46; y++) for (let x = 2; x <= 47; x++) open.add(y * 50 + x);
    const walls = [];
    for (let y = 1; y <= 48; y++) for (let x = 1; x <= 48; x++) if (!open.has(y * 50 + x)) walls.push([x, y]);
    const world = createWorld({ spawn: [10, 43], sources: [[5, 41], [40, 45]], controller: [25, 46], walls });
    for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'src'))) delete require.cache[k];
    delete global.__v2heap;
    return world;
}

/** @param {any} world @param {string} name @param {number} x @param {string[]} body */
function addCreep(world, name, x, body) {
    const c = new global.Creep(world, x, 25, name, body);
    global.Game.creeps[name] = c;
    return c;
}

/**
 * Walks `a` toward x=20 for up to 20 ticks while `b` stays idle (optionally working).
 * @param {boolean} trafficOn
 * @param {(b: any, traffic: any) => void} [idle]
 */
function walk(trafficOn, idle) {
    const world = corridorWorld();
    const a = addCreep(world, 'hauler_a', 10, ['carry', 'move']);
    const b = addCreep(world, 'worker_b', 12, ['work', 'carry', 'move']);
    const movement = require('../src/services/movement');
    const traffic = require('../src/services/traffic');
    const goal = new global.RoomPosition(20, 25, 'W1N1');
    for (let i = 0; i < 20 && !a.pos.isEqualTo(goal); i++) {
        movement.to(a, goal, { range: 0 });
        if (idle) idle(b, traffic);
        if (trafficOn) traffic.resolve(world.room);
        world.endTick();
    }
    return { a, b, goal };
}

test('without traffic an idle creep blocks a one-tile lane', () => {
    const { a, goal } = walk(false);
    assert.ok(!a.pos.isEqualTo(goal), `stuck at ${a.pos.x}`);
    assert.ok(a.pos.x < 12);
});

test('with traffic the idle creep is moved aside and the hauler gets through', () => {
    const { a, b, goal } = walk(true);
    assert.ok(a.pos.isEqualTo(goal), `hauler at ${a.pos.x}`);
    assert.notEqual(b.pos.x, a.pos.x);
});

test('pinned creeps are never shoved', () => {
    const { a, b } = walk(true, (b, traffic) => traffic.pin(b));
    assert.equal(b.pos.x, 12, 'pinned creep stays');
    assert.ok(a.pos.x < 12, 'hauler waits behind it');
});

test('a shoved creep repaths instead of following a stale path', () => {
    const world = corridorWorld();
    const a = addCreep(world, 'hauler_a', 10, ['carry', 'move']);
    const b = addCreep(world, 'hauler_b', 14, ['carry', 'move']);
    const movement = require('../src/services/movement');
    const traffic = require('../src/services/traffic');
    const goalA = new global.RoomPosition(20, 25, 'W1N1');
    const goalB = new global.RoomPosition(16, 25, 'W1N1');
    for (let i = 0; i < 30; i++) {
        if (!a.pos.isEqualTo(goalA)) movement.to(a, goalA, { range: 0 });
        if (!b.pos.isEqualTo(goalB)) movement.to(b, goalB, { range: 0 });
        traffic.resolve(world.room);
        world.endTick();
    }
    assert.ok(a.pos.isEqualTo(goalA), `a at ${a.pos.x}`);
    // b was pushed past its goal by a and must come back, not walk on along an old path.
    assert.ok(b.pos.isEqualTo(goalB), `b at ${b.pos.x}`);
});
