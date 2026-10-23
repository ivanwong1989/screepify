'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeRoom, proc } = require('./helpers/mockGame');

function load() {
    return require('../src/kernel/kernel');
}

test('runs phases in order, then priority within a phase', (t) => {
    const w = setup();
    t.after(() => w.restore());
    const order = [];
    const mk = (id, phase, priority) => proc({ id, phase, priority, run: () => order.push(id) });
    const k = load().createKernel([
        mk('report.a', 'REPORT'),
        mk('act.late', 'ACT', 200),
        mk('act.early', 'ACT', 10),
        mk('plan.a', 'PLAN'),
        mk('sense.a', 'SENSE')
    ]);
    k.tick();
    assert.deepEqual(order, ['sense.a', 'plan.a', 'act.early', 'act.late', 'report.a']);
});

test('room scope runs once per tracked room, shard scope once per tick', (t) => {
    const w = setup({
        rooms: { W1N1: makeRoom('W1N1'), W2N2: makeRoom('W2N2'), W3N3: makeRoom('W3N3', { my: false }) }
    });
    t.after(() => w.restore());
    const seen = [];
    const k = load().createKernel([
        proc({ id: 'r', scope: 'room', run: (ctx, room) => seen.push(`r:${room.name}`) }),
        proc({ id: 's', scope: 'shard', run: () => seen.push('s') })
    ]);
    k.tick();
    assert.deepEqual(seen.sort(), ['r:W1N1', 'r:W2N2', 's']);
});

test('remote rooms recorded in Memory are tracked too', (t) => {
    const w = setup({
        rooms: { W1N1: makeRoom('W1N1'), W1N2: makeRoom('W1N2', { my: false }) },
        memory: { v: 2, creeps: {}, rooms: { W1N2: { k: 'remote' } } }
    });
    t.after(() => w.restore());
    const kinds = {};
    const k = load().createKernel([
        proc({ id: 'r', scope: 'room', run: (ctx, room) => { kinds[room.name] = room.kind; } })
    ]);
    k.tick();
    assert.deepEqual(kinds, { W1N1: 'owned', W1N2: 'remote' });
});

test('room processes can be limited to room kinds', (t) => {
    const w = setup({
        rooms: { W1N1: makeRoom('W1N1'), W1N2: makeRoom('W1N2', { my: false }) },
        memory: { v: 2, creeps: {}, rooms: { W1N2: { k: 'remote' } } }
    });
    t.after(() => w.restore());
    const seen = [];
    const k = load().createKernel([
        proc({ id: 'own', scope: 'room', kinds: ['owned'], run: (ctx, room) => seen.push(room.name) })
    ]);
    k.tick();
    assert.deepEqual(seen, ['W1N1']);
});

test('cadence: every N runs once per N ticks, staggered per key', (t) => {
    const w = setup({ rooms: { W1N1: makeRoom('W1N1'), W5N9: makeRoom('W5N9') } });
    t.after(() => w.restore());
    const ticks = { W1N1: [], W5N9: [] };
    const k = load().createKernel([
        proc({ id: 'r', scope: 'room', every: 5, run: (ctx, room) => ticks[room.name].push(ctx.time) })
    ]);
    for (let i = 0; i < 20; i++) {
        k.tick();
        w.nextTick();
    }
    assert.equal(ticks.W1N1.length, 4);
    assert.equal(ticks.W5N9.length, 4);
    const { isDue } = load();
    assert.equal(isDue(1, 'x', 7), true);
    assert.equal(isDue(0, 'x', 7), true);
});

test('force: a room process runs off cadence while force() is true', (t) => {
    const w = setup({ rooms: { W1N1: makeRoom('W1N1') } });
    t.after(() => w.restore());
    const ran = [];
    let needed = true;
    const k = load().createKernel([
        proc({ id: 'r', scope: 'room', every: 1000, force: () => needed, run: (ctx) => { ran.push(ctx.time); needed = false; } })
    ]);
    for (let i = 0; i < 5; i++) {
        k.tick();
        w.nextTick();
    }
    assert.equal(ran.length, 1, 'forced once, then back on its 1000-tick cadence');
});

test('over budget: normal is skipped and owed, critical always runs', (t) => {
    const w = setup({ bucket: 5000, limit: 20 }); // soft limit = 19
    t.after(() => w.restore());
    const ran = [];
    const k = load().createKernel([
        proc({ id: 'hog', priority: 1, run: () => { ran.push('hog'); w.spend(18); } }),
        proc({ id: 'normal', priority: 2, run: () => { ran.push('normal'); w.spend(5); } }),
        proc({ id: 'crit', tier: 'critical', priority: 3, run: () => { ran.push('crit'); w.spend(5); } })
    ]);
    // First tick: 'normal' has no estimate yet, so it runs and gets measured.
    k.tick();
    w.nextTick();
    ran.length = 0;
    k.tick();
    assert.deepEqual(ran, ['hog', 'crit']);
    assert.ok(k.state().owed.has('normal'));
    w.nextTick();
    ran.length = 0;
    k.tick();
    assert.equal(ran[0], 'normal', 'owed process runs first next tick');
});

test('a process skipped for budget is never starved', (t) => {
    const w = setup({ bucket: 5000, limit: 20, memory: { v: 2, creeps: {}, rooms: {}, config: { kernel: { maxOwedTicks: 5 } } } });
    t.after(() => w.restore());
    let runs = 0;
    const k = load().createKernel([
        proc({ id: 'spiky', run: () => { runs++; if (runs === 1) w.spend(500); } })
    ]);
    k.tick(); // one 500-CPU run inflates the estimate far above the budget
    w.nextTick();
    for (let i = 0; i < 10; i++) {
        k.tick();
        w.nextTick();
    }
    assert.ok(runs >= 2, 'ran again after maxOwedTicks');
});

test('low tier is blocked while bucket is below the floor', (t) => {
    const w = setup({ bucket: 500 });
    t.after(() => w.restore());
    const ran = [];
    const k = load().createKernel([
        proc({ id: 'low', tier: 'low', run: () => ran.push('low') }),
        proc({ id: 'normal', tier: 'normal', run: () => ran.push('normal') })
    ]);
    k.tick();
    assert.deepEqual(ran, ['normal']);
    Game.cpu.bucket = 2000;
    w.nextTick();
    k.tick();
    assert.deepEqual(ran, ['normal', 'low', 'normal']);
});

test('a throwing process does not stop others and is quarantined after repeated failures', (t) => {
    const w = setup({ memory: { v: 2, creeps: {}, rooms: {}, config: { kernel: { quarantineAfter: 3, quarantineTicks: 10 } } } });
    t.after(() => w.restore());
    let after = 0;
    let attempts = 0;
    const k = load().createKernel([
        proc({ id: 'bad', priority: 1, run: () => { attempts++; throw new Error('boom'); } }),
        proc({ id: 'good', priority: 2, run: () => { after++; } })
    ]);
    for (let i = 0; i < 5; i++) {
        k.tick();
        w.nextTick();
    }
    assert.equal(after, 5);
    assert.equal(attempts, 3, 'stops being called once quarantined');
    assert.ok(k.state().quarantine.bad > Game.time);
    assert.ok(w.logs.some(l => l.includes('process bad threw')));
    for (let i = 0; i < 10; i++) {
        k.tick();
        w.nextTick();
    }
    assert.ok(attempts > 3, 'released after quarantineTicks');
});

test('config can disable a process or override its cadence', (t) => {
    const w = setup({
        memory: { v: 2, creeps: {}, rooms: {}, config: { processes: { off: { enabled: false }, slow: { every: 4 } } } }
    });
    t.after(() => w.restore());
    const counts = { off: 0, slow: 0 };
    const k = load().createKernel([
        proc({ id: 'off', run: () => counts.off++ }),
        proc({ id: 'slow', run: () => counts.slow++ })
    ]);
    for (let i = 0; i < 8; i++) {
        k.tick();
        w.nextTick();
    }
    assert.deepEqual(counts, { off: 0, slow: 2 });
});

test('burst: runs one job when the bucket allows, flags pending otherwise', (t) => {
    const w = setup({ bucket: 3000 });
    t.after(() => w.restore());
    let runs = 0;
    let pendingSeen = null;
    const k = load().createKernel([
        proc({ id: 'planner', tier: 'burst', bucketNeeded: 5000, pending: () => true, run: () => runs++ }),
        proc({ id: 'probe', phase: 'REPORT', run: (ctx) => { pendingSeen = ctx.kernel.burstPending; } })
    ]);
    k.tick();
    assert.equal(runs, 0);
    assert.equal(pendingSeen, true);
    Game.cpu.bucket = 6000;
    w.nextTick();
    k.tick();
    assert.equal(runs, 1);
    assert.equal(k.state().lastTick.burst, 'planner');
});

test('validate rejects bad registries', (t) => {
    const w = setup();
    t.after(() => w.restore());
    const { createKernel } = load();
    assert.throws(() => createKernel([proc({ id: 'a' }), proc({ id: 'a' })]), /duplicate/);
    assert.throws(() => createKernel([proc({ id: 'a', tier: 'urgent' })]), /bad tier/);
    assert.throws(() => createKernel([proc({ id: 'a', tier: 'burst' })]), /pending/);
    assert.throws(() => createKernel([proc({ id: 'a', phase: 'NOW' })]), /bad phase/);
});

test('softLimit bands follow the bucket', (t) => {
    const w = setup();
    t.after(() => w.restore());
    const { softLimit } = load();
    assert.equal(softLimit(20, 500), 16);
    assert.equal(softLimit(20, 5000), 19);
    assert.equal(softLimit(20, 9000), 24);
});

test('kernel migrates v1 Memory before running processes', (t) => {
    const w = setup({ memory: { military: { x: 1 }, spawnTickets: {}, creeps: { old: {} } } });
    t.after(() => w.restore());
    let seenVersion = null;
    const k = load().createKernel([proc({ id: 'p', run: () => { seenVersion = Memory.v; } })]);
    k.tick();
    assert.equal(seenVersion, 2);
    assert.equal(Memory.military, undefined);
});
