'use strict';

/**
 * Assignment (plan.assignment): who leaves idle:upgrade, and when. Live on
 * 2026-10-24 workers were pulled off idle:upgrade whenever any higher mission
 * was short, even a hauler one, and some were left with no mission.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createWorld } = require('./helpers/sim');

const ROOT = path.join(__dirname, '..');
function fresh() {
    createWorld({ spawn: [25, 25], sources: [[10, 10]], controller: [40, 40] });
    for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'src'))) delete require.cache[k];
    delete global.__v2heap;
    return require('../src/processes/plan/assignment');
}

/** @param {string} name @param {string} a @param {string} [m] @param {string[]} [parts] */
function creep(name, a, m, parts) {
    const body = (parts || (a === 'worker' ? ['work', 'carry', 'move'] : ['carry', 'carry', 'move'])).map(type => ({ type, hits: 100 }));
    const c = {
        name, body, spawning: false, room: global.Game.rooms.W1N1, pos: new RoomPosition(25, 25, 'W1N1'),
        memory: { a, h: 'W1N1', m, s: m ? 'working' : undefined, t: m ? { a: 'upgrade', i: 'ctrl' } : undefined }
    };
    global.Game.creeps[name] = c;
    return c;
}

const idle = { id: 'idle:upgrade', type: 'upgrade', home: 'W1N1', room: 'W1N1', archetype: 'worker', demand: { minCreeps: 0, maxCreeps: 4 }, spawn: false, priority: -100 };
const supply = { id: 'supply:tower', type: 'transfer', home: 'W1N1', room: 'W1N1', archetype: 'hauler', demand: { minCreeps: 1, maxCreeps: 1 }, spawn: 'pool', priority: 50 };
const repair = { id: 'repair:wall', type: 'repair', home: 'W1N1', room: 'W1N1', archetype: 'worker', demand: { work: 1, minCreeps: 1, maxCreeps: 1 }, spawn: 'pool', priority: 65 };

function run(assignment, missions, creeps) {
    const rc = { name: 'W1N1', room: global.Game.rooms.W1N1, missions, census: { active: creeps, creeps } };
    assignment.run({}, rc);
}

test('a short hauler mission leaves the workers on idle:upgrade alone', () => {
    const assignment = fresh();
    const w = [creep('w1', 'worker', 'idle:upgrade'), creep('w2', 'worker', 'idle:upgrade')];
    run(assignment, [idle, supply], w);
    for (const c of w) {
        assert.equal(c.memory.m, 'idle:upgrade', `${c.name} stays`);
        assert.deepEqual(c.memory.t, { a: 'upgrade', i: 'ctrl' }, `${c.name} keeps its task`);
    }
});

test('only as many workers leave idle:upgrade as the worker mission needs', () => {
    const assignment = fresh();
    const w = [creep('w1', 'worker', 'idle:upgrade'), creep('w2', 'worker', 'idle:upgrade'), creep('w3', 'worker', 'idle:upgrade')];
    run(assignment, [idle, repair], w);
    const onRepair = w.filter(c => c.memory.m === 'repair:wall').length;
    const onIdle = w.filter(c => c.memory.m === 'idle:upgrade').length;
    assert.equal(onRepair, 1, 'one goes to repair');
    assert.equal(onIdle, 2, 'the others keep upgrading');
});

test('no worker ends a round without a mission while idle:upgrade has room', () => {
    const assignment = fresh();
    const w = [creep('w1', 'worker', undefined), creep('w2', 'worker', 'idle:upgrade')];
    for (let i = 0; i < 3; i++) run(assignment, [idle, supply, repair], w);
    assert.ok(w.every(c => c.memory.m), JSON.stringify(w.map(c => c.memory.m)));
});

test('sim: a finished mission does not keep catching and dropping the same creep', () => {
    const { boot } = require('./helpers/runSim');
    const sim = boot({ spawn: [24, 20], sources: [[5, 5], [44, 44]], controller: [10, 40] }, {
        deterministic: true, config: { construction: { enabled: false } }
    });
    const w = sim.world;
    w.controller.level = 5;
    const storage = w.addStructure('storage', 26, 20);
    storage.store.energy = 200000;
    sim.run(600);
    // A damaged wall the repair mission will pick up, then repaired by "someone else".
    const wall = w.addStructure('constructedWall', 30, 30);
    wall.hitsMax = 300000000;
    wall.hits = 1000;
    sim.run(60);
    const ids = () => require('../src/services/cache').store('room.missions').W1N1.list.map(m => m.id);
    assert.ok(ids().includes(`repair:${wall.id}`), 'repair mission up');
    wall.hits = 300000000;
    // Count releases: a creep dropped from its mission (by assignment or
    // because its mission had nothing for it).
    const state = require('../src/missions/shared/state');
    const release = state.release;
    let dropped = 0;
    const per = {};
    state.release = (c) => {
        dropped++;
        // Loop signature: handed a mission and dropped before doing anything on it.
        if (!c.memory.t) {
            const k = `${c.name} ${c.memory.m}`;
            per[k] = (per[k] || 0) + 1;
        }
        return release(c);
    };
    try {
        sim.run(40);
    } finally {
        state.release = release;
    }
    // Finishing a job releases a creep once; before the fix assignment
    // released every upgrader each tick (340 in 40 ticks).
    assert.ok(dropped <= 20, `creeps dropped from their mission over 40 ticks: ${dropped}`);
    const repeats = Object.entries(per).filter(([, n]) => n > 1);
    assert.deepEqual(repeats, [], 'no creep handed the same mission and dropped with nothing done, twice');
});

test('a mission found finished is not handed out or spawned for until it is refreshed', () => {
    const assignment = fresh();
    const marks = require('../src/services/missionMarks');
    const spawns = require('../src/processes/act/spawns');
    const stale = { ...repair, id: 'repair:done' };
    marks.markFinished(stale);
    const w = [creep('w1', 'worker', 'idle:upgrade')];
    run(assignment, [idle, stale], w);
    assert.equal(w[0].memory.m, 'idle:upgrade', 'not moved onto a finished mission');
    assert.deepEqual(spawns.contracts([stale], 1000), [], 'no spawn contract for it');
    const refreshed = { ...repair, id: 'repair:done' }; // a new object from the generator
    assert.equal(spawns.contracts([refreshed], 1000).length, 1, 'refreshed mission spawns again');
    run(assignment, [idle, refreshed], w);
    assert.equal(w[0].memory.m, 'repair:done', 'and is handed out again');
});


test('no mission list (planning skipped this tick): nobody is released', () => {
    const assignment = fresh();
    const w = [creep('w1', 'worker', 'idle:upgrade'), creep('w2', 'worker', 'repair:wall')];
    const rc = { name: 'W1N1', room: global.Game.rooms.W1N1, missions: undefined, census: { active: w, creeps: w } };
    assignment.run({}, rc);
    assert.deepEqual(w.map(c => c.memory.m), ['idle:upgrade', 'repair:wall'], 'missions kept');
    assert.ok(w.every(c => c.memory.t), 'tasks kept');
});

test('sim: after a code reload with mission planning held back, creeps keep their missions', () => {
    const { boot } = require('./helpers/runSim');
    const sim = boot({ spawn: [24, 20], sources: [[5, 5], [44, 44]], controller: [10, 40] }, {
        deterministic: true, config: { construction: { enabled: false } }
    });
    sim.world.controller.level = 5;
    sim.world.addStructure('storage', 26, 20).store.energy = 200000;
    sim.run(800);
    const before = Object.fromEntries(Object.values(Game.creeps).filter(c => c.memory.m).map(c => [c.name, c.memory.m]));
    assert.ok(Object.keys(before).length > 5, 'creeps on missions');
    sim.reload();
    // Same effect as plan.missions being skipped for budget on the first ticks.
    require('../src/config').set('processes.plan.missions.enabled', false);
    sim.run(3);
    const kept = Object.entries(before).filter(([n, m]) => Game.creeps[n] && Game.creeps[n].memory.m === m).length;
    assert.equal(kept, Object.keys(before).filter(n => Game.creeps[n]).length, 'no creep lost its mission');
    require('../src/config').set('processes.plan.missions.enabled', true);
    sim.run(5);
    assert.ok(Object.values(Game.creeps).filter(c => c.memory.m).length >= Object.keys(before).length - 2, 'back to work');
});
