'use strict';

/**
 * Unit tests for the economy rules ported from v1.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createWorld } = require('./helpers/sim');
const { DEFAULT_ROOM } = require('./helpers/runSim');

const ROOT = path.join(__dirname, '..');
function fresh() {
    const world = createWorld(DEFAULT_ROOM);
    for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'src'))) delete require.cache[k];
    delete global.__v2heap;
    return world;
}
const mission = (o) => Object.assign({ home: 'W1N1', room: 'W1N1', priority: 50, demand: { minCreeps: 1 }, spawn: 'pool' }, o);

test('body recipes match v1', () => {
    fresh();
    const body = require('../src/services/body');
    assert.deepEqual(body.build('miner', 550), ['work', 'work', 'work', 'work', 'carry', 'move']);
    assert.deepEqual(body.build('miner', 300, { mode: 'mobile' }), ['work', 'carry', 'move', 'move']);
    assert.deepEqual(body.build('hauler', 300), ['carry', 'carry', 'carry', 'move', 'move', 'move']);
    assert.deepEqual(body.build('worker', 450), ['work', 'work', 'carry', 'carry', 'move', 'move']);
    assert.equal(body.build('worker', 10000).length, 45, 'worker capped at 3000 energy');
    assert.equal(body.build('hauler', 10000, { maxCarry: 25 }).length, 50);
});

test('spawn contracts: pools add up, slots split, desired from WORK demand', () => {
    fresh();
    const spawns = require('../src/processes/act/spawns');
    const list = spawns.contracts([
        mission({ id: 'upgrade:controller', archetype: 'worker', demand: { work: 15, minCreeps: 1, maxCreeps: 20 }, priority: 50 }),
        mission({ id: 'build:x', archetype: 'worker', demand: { work: 5, minCreeps: 1, maxCreeps: 5 }, priority: 60 }),
        mission({ id: 'harvest:s', archetype: 'miner', spawn: 'slots', slots: ['a', 'b', 'c'], demand: { work: 7, minCreeps: 1, maxCreeps: 3 }, priority: 100, bodyOpts: { mode: 'static' } }),
        mission({ id: 'idle', archetype: 'worker', spawn: false })
    ], 550);
    const pool = list.find(c => c.key === 'pool:worker');
    assert.equal(pool.desired, 8 + 3, '15/2 + 5/2 workers at 550 energy');
    assert.equal(pool.priority, 60, 'pool takes the highest priority');
    assert.deepEqual(list.filter(c => c.mode === 'slots').map(c => c.key), ['a', 'b'], '7 WORK / 4 per miner = 2 slots');
});

test('spawn selection: after 5 of one archetype, prefer another', () => {
    fresh();
    const spawns = require('../src/processes/act/spawns');
    const unmet = [{ archetype: 'miner', key: 'm' }, { archetype: 'hauler', key: 'h' }];
    assert.equal(spawns.select(unmet, ['miner', 'miner', 'miner', 'miner']).key, 'm');
    assert.equal(spawns.select(unmet, ['miner', 'miner', 'miner', 'miner', 'miner']).key, 'h');
});

test('spawn fulfillment: near-death miners stop counting so replacements spawn early', () => {
    const world = fresh();
    const spawns = require('../src/processes/act/spawns');
    const list = [{ key: 'slot:0', archetype: 'miner', desired: 1, priority: 100, lead: 30, mode: 'slots' },
        { key: 'pool:hauler', archetype: 'hauler', desired: 2, priority: 85, lead: 0, mode: 'pool' }];
    const mk = (name, a, ttl, b) => {
        const c = new Creep(world, 20, 20, name, ['work', 'carry', 'move']);
        c.ticksToLive = ttl;
        global.Memory.creeps[name] = { a, h: 'W1N1', b };
        return c;
    };
    const old = mk('old', 'miner', 30, 'slot:0'); // 9 spawn + 30 lead → near death
    const h1 = mk('h1', 'hauler', 1000);
    assert.deepEqual(spawns.fulfillment(list, [old, h1], 0), { 'slot:0': 0, 'pool:hauler': 1 });
    old.ticksToLive = 500;
    assert.equal(spawns.fulfillment(list, [old, h1], 0)['slot:0'], 1);
});

test('assignment: underfilled rules and best mission (priority band, then closest)', () => {
    const world = fresh();
    const assignment = require('../src/processes/plan/assignment');
    const st = (m, count, work) => ({ mission: m, count, work: work || 0, carry: 0, claim: 0 });
    assert.equal(assignment.underfilled(st(mission({ demand: { minCreeps: 1, maxCreeps: 1 } }), 1)), false);
    assert.equal(assignment.underfilled(st(mission({ demand: { work: 5, minCreeps: 1, maxCreeps: 5 } }), 2, 4)), true);
    assert.equal(assignment.underfilled(st(mission({ demand: { minCreeps: 0, maxCreeps: 3 } }), 2)), true, 'no floor: fill to max');

    const creep = new Creep(world, 20, 20, 'w', ['work', 'carry', 'move']);
    global.Memory.creeps.w = { a: 'worker', h: 'W1N1' };
    const near = mission({ id: 'near', type: 'build', archetype: 'worker', priority: 60, pos: new RoomPosition(21, 21, 'W1N1'), demand: { minCreeps: 1, maxCreeps: 2 } });
    const far = mission({ id: 'far', type: 'build', archetype: 'worker', priority: 60, pos: new RoomPosition(40, 40, 'W1N1'), demand: { minCreeps: 1, maxCreeps: 2 } });
    const low = mission({ id: 'low', type: 'upgrade', archetype: 'worker', priority: 10, demand: { minCreeps: 1 } });
    const hauling = mission({ id: 'haul', type: 'transfer', archetype: 'hauler', priority: 99, demand: { minCreeps: 1, maxCreeps: 1 } });
    const status = {};
    for (const m of [hauling, far, near, low]) status[m.id] = st(m, 0);
    assert.equal(assignment.bestMission(creep, [hauling, far, near, low], status, 'W1N1').id, 'near');
});

test('actions: harvest finishes when the next harvest fills the creep; transfer is one shot', () => {
    const world = fresh();
    const actions = require('../src/actions/index');
    const { CONTINUE, DONE, SKIP } = require('../src/contracts/task');
    const src = world.sources[0];
    const creep = new Creep(world, src.pos.x + 1, src.pos.y, 'm', ['work', 'work', 'carry', 'move']);
    global.Memory.creeps.m = { a: 'miner', h: 'W1N1' };
    assert.equal(actions.run(creep, { a: 'harvest', i: src.id }), CONTINUE);
    creep.store.energy = 46;
    assert.equal(actions.run(creep, { a: 'harvest', i: src.id }), DONE);

    const spawn = world.structures[0];
    spawn.store.energy = 0;
    assert.equal(actions.run(creep, { a: 'transfer', i: spawn.id }), CONTINUE, 'walks first');
    creep.pos = new RoomPosition(spawn.pos.x + 1, spawn.pos.y, 'W1N1');
    assert.equal(actions.run(creep, { a: 'transfer', i: spawn.id }), DONE);
    spawn.store.energy = 300;
    assert.equal(actions.run(creep, { a: 'transfer', i: spawn.id }), SKIP, 'target full');
    assert.equal(actions.run(creep, { a: 'wait', q: Game.time + 3 }), CONTINUE);
});

test('layout: checkerboard extensions, clear spawn ring, roads to sources and controller', () => {
    const world = fresh();
    const construction = require('../src/processes/plan/construction');
    const spawn = world.structures[0];
    const plan = construction.layout(world.room, spawn);
    const parity = (spawn.pos.x + spawn.pos.y) % 2;
    assert.equal(plan.s.extension.length, 60);
    for (const i of plan.s.extension) {
        const x = i % 50;
        const y = Math.floor(i / 50);
        assert.equal((x + y) % 2, parity, 'checkerboard');
        assert.ok(Math.max(Math.abs(x - spawn.pos.x), Math.abs(y - spawn.pos.y)) >= 2, 'spawn ring clear');
    }
    assert.equal(plan.s.container.length, 3, 'two sources + controller');
    assert.ok(plan.s.road.length > 10);
    const all = [].concat(...Object.values(plan.s)).filter(i => i !== plan.anchor);
    assert.equal(new Set(all).size, all.length, 'no tile planned twice');
});

test('movement: serialized paths skip room changes', () => {
    fresh();
    const movement = require('../src/services/movement');
    const a = new RoomPosition(10, 10, 'W1N1');
    const path = [new RoomPosition(11, 10, 'W1N1'), new RoomPosition(12, 11, 'W1N1'), new RoomPosition(12, 12, 'W1N1')];
    assert.equal(movement.serialize(a, path), '345');
});
