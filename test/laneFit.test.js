'use strict';

/**
 * Lane fit (services/laneFit, plan.laneFit): spawns, towers and extensions on
 * free tiles next to a hand-built core lane.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createWorld } = require('./helpers/sim');

const ROOT = path.join(__dirname, '..');
const CORE = { spawn: [24, 20], sources: [[5, 5], [44, 44]], controller: [10, 40] };
const HEAD = [25, 21];

function freshModules() {
    for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'src'))) delete require.cache[k];
    delete global.__v2heap;
}

const P = (x, y) => y * 50 + x;
const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));

/**
 * RCL 8 room: spawn (24,20), storage (26,20), a straight road lane from the
 * head (25,21) down to (25, 21 + len - 1), saved as the room's lane.
 */
function room(opts = {}) {
    const world = createWorld(Object.assign({}, CORE, opts.spec || {}));
    freshModules();
    world.controller.level = 8;
    world.addStructure('storage', 26, 20);
    const tiles = opts.tiles || Array.from({ length: opts.len || 10 }, (_, i) => [25, 21 + i]);
    for (const [x, y] of tiles) world.addStructure('road', x, y);
    if (opts.build) opts.build(world);
    if (opts.flags) {
        const find = world.room.find.bind(world.room);
        world.room.find = (type, o) => (type === global.FIND_FLAGS ? opts.flags : find(type, o));
    }
    saveLane(world, tiles);
    return world;
}

function saveLane(world, tiles) {
    const laneStore = require('../src/services/laneStore');
    const p = tiles.map(([x, y]) => P(x, y));
    laneStore.save(world.roomName, { head: p[0], sourceId: world.room.storage.id, best: { path: p, loop: false, covered: 0, weighted: 0, end: p[p.length - 1] } },
        laneStore.signature(world.room));
}

function planFor(world, budget = Infinity) {
    const laneStore = require('../src/services/laneStore');
    const lane = laneStore.get(world.room);
    return require('../src/services/laneFit').plan(world.room, lane, budget);
}

test('slots: next to the lane, never on a road, the hub or the lane itself', () => {
    const world = room();
    const { picks, need } = planFor(world);
    assert.deepEqual(need, { spawn: 2, tower: 6, extension: 60 }, 'RCL 8 allowance minus the one spawn');
    assert.ok(picks.length > 0);
    const lane = Array.from({ length: 10 }, (_, i) => [25, 21 + i]);
    for (const p of picks) {
        const xy = [p.x, p.y];
        assert.ok(lane.some(t => cheb(t, xy) === 1), `${xy} next to the lane`);
        assert.ok(!lane.some(t => t[0] === p.x && t[1] === p.y), `${xy} not on the lane`);
        assert.ok(cheb(xy, [26, 20]) > 1, `${xy} keeps storage open`);
    }
    assert.equal(new Set(picks.map(p => P(p.x, p.y))).size, picks.length, 'no tile twice');
    // A 10-tile straight lane has 2 x 10 side tiles plus the end cap, minus the hub.
    assert.ok(picks.length <= 23, `${picks.length} picks`);
});

test('order: spawns closest to the head, extensions walk outward, towers near storage but not adjacent', () => {
    const world = room({ len: 16 });
    const { picks } = planFor(world);
    const spawns = picks.filter(p => p.type === 'spawn');
    const towers = picks.filter(p => p.type === 'tower');
    const exts = picks.filter(p => p.type === 'extension');
    assert.equal(spawns.length, 2);
    const minD = Math.min(...picks.map(p => p.d));
    assert.equal(spawns[0].d, minD, 'first spawn at the closest slot');
    for (let i = 1; i < exts.length; i++) assert.ok(exts[i].d >= exts[i - 1].d, 'extensions in lane order');
    assert.equal(towers.length, 6);
    let closest = Infinity;
    for (let i = 0; i < towers.length; i++) {
        for (let j = i + 1; j < towers.length; j++) closest = Math.min(closest, cheb([towers[i].x, towers[i].y], [towers[j].x, towers[j].y]));
    }
    assert.ok(closest >= 2, `towers at least 2 apart (closest ${closest})`);
    const far = Math.max(...towers.map(t => cheb([t.x, t.y], [26, 20])));
    const extFar = Math.max(...exts.map(e => cheb([e.x, e.y], [26, 20])));
    assert.ok(far < extFar, `towers (max range ${far}) nearer storage than the farthest extension (${extFar})`);
});

test('budget and RCL: never more picks than the budget or the RCL allows', () => {
    const world = room();
    assert.equal(planFor(world, 2).picks.length, 2);
    world.controller.level = 3; // 10 extensions, 1 tower, 1 spawn
    const { picks, need } = planFor(world);
    assert.deepEqual(need, { spawn: 0, tower: 1, extension: 10 });
    assert.equal(picks.filter(p => p.type === 'tower').length, 1);
    assert.equal(picks.filter(p => p.type === 'extension').length, 10);
});

test('connectivity: never fills the only gap to the controller, sources and exit', () => {
    // A wall across y = 32 with one gap at (26,32), right next to the lane end (25,31).
    const walls = [];
    for (let x = 1; x <= 48; x++) if (x !== 26) walls.push([x, 32]);
    const world = room({ len: 11, spec: { walls } });
    const { picks } = planFor(world);
    assert.ok(picks.length > 0);
    assert.ok(!picks.some(p => p.x === 26 && p.y === 32), 'gap stays open');
});

test('manual control: NOBUILD flags veto a tile; sources and the controller keep their space', () => {
    const plain = planFor(room());
    const first = plain.picks[0];
    const flag = { name: 'NOBUILD1', pos: new global.RoomPosition(first.x, first.y, 'W1N1') };
    const { picks } = planFor(room({ flags: [flag] }));
    assert.ok(!picks.some(p => p.x === first.x && p.y === first.y), 'flagged tile skipped');

    // A lane passing next to the controller (10,40) leaves its neighbours free.
    const tiles = [[25, 21]].concat(Array.from({ length: 12 }, (_, i) => [13 - i, 41]));
    const near = planFor(room({ tiles }));
    assert.ok(!near.picks.some(p => cheb([p.x, p.y], [10, 40]) <= 1), 'controller neighbours free');
});

test('reshaped lane: the slots follow the new path', () => {
    const world = room();
    const before = planFor(world).picks;
    assert.ok(before.every(p => p.x >= 24 && p.x <= 26), 'along the old vertical lane');
    // The player demolishes and lays a new lane going right; plan.lanes saves it.
    const tiles = [[25, 21]].concat(Array.from({ length: 10 }, (_, i) => [26 + i, 22]));
    for (const [x, y] of tiles) world.addStructure('road', x, y);
    Game.time += 100;
    saveLane(world, tiles);
    const after = planFor(world).picks;
    assert.ok(after.length > 0);
    for (const p of after) assert.ok(tiles.some(t => cheb(t, [p.x, p.y]) === 1), `${p.x},${p.y} next to the new lane`);
    assert.ok(after.some(p => p.x >= 30), 'uses the new stretch');
});

test('plan.laneFit: off by default, places up to maxSites, waits for a stale lane', () => {
    const world = room();
    const proc = require('../src/processes/plan/laneFit');
    const config = require('../src/config');
    assert.equal(config.get().laneFit.enabled, false, 'off by default');
    const ctx = { config: { laneFit: { enabled: true, maxSites: 2, rooms: [] } } };
    const rc = { name: 'W1N1', room: world.room, intel: { hostiles: [] } };

    Game.time += 100;
    proc.run(ctx, rc);
    assert.equal(world.sites.length, 2, 'two sites placed');
    assert.ok(world.sites.every(s => ['spawn', 'tower', 'extension'].includes(s.structureType)));

    Game.time += 100;
    proc.run(ctx, rc);
    assert.equal(world.sites.length, 2, 'no more while maxSites are open');

    // The new sites changed the room signature: the saved lane is stale until plan.lanes rebuilds it.
    ctx.config.laneFit.maxSites = 4;
    Game.time += 100;
    proc.run(ctx, rc);
    assert.equal(world.sites.length, 2, 'waits for the lane rebuild');

    Game.time += 100;
    saveLane(world, Array.from({ length: 10 }, (_, i) => [25, 21 + i]));
    rc.intel.hostiles = [{}];
    Game.time += 100;
    proc.run(ctx, rc);
    assert.equal(world.sites.length, 2, 'waits while hostiles are in the room');

    rc.intel.hostiles = [];
    ctx.config.laneFit.rooms = ['W2N2'];
    Game.time += 100;
    proc.run(ctx, rc);
    assert.equal(world.sites.length, 2, 'only listed rooms');

    ctx.config.laneFit.rooms = [];
    Game.time += 100;
    proc.run(ctx, rc);
    assert.equal(world.sites.length, 4, 'fills up to maxSites once the lane is current');
});
