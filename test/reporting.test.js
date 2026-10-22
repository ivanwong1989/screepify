'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeRoom, proc } = require('./helpers/mockGame');

test('telemetry: runAvg estimates one run, tickAvg spreads it over ticks', (t) => {
    const w = setup();
    t.after(() => w.restore());
    const telemetry = require('../src/kernel/telemetry');
    telemetry.record('p', 'W1N1', 4);
    telemetry.endTick(5, 4);
    assert.equal(telemetry.estimate('p'), 4);
    for (let i = 0; i < 30; i++) telemetry.endTick(1, 0);
    assert.equal(telemetry.estimate('p'), 4, 'idle ticks do not change the run estimate');
    assert.ok(telemetry.state().procs.p.tickAvg < 0.2, 'but the per-tick share decays');
    assert.ok(telemetry.state().rooms.W1N1 < 0.5);
    assert.equal(telemetry.estimate('unknown'), 0);
});

test('stats are written to the configured segment, after it becomes active', (t) => {
    const w = setup({ rooms: { W1N1: makeRoom('W1N1', { level: 3 }) } });
    t.after(() => w.restore());
    const { createKernel } = require('../src/kernel/kernel');
    const stats = require('../src/processes/report/stats');
    const k = createKernel([proc({ id: 'work', run: () => w.spend(2) }), Object.assign({}, stats, { every: 1 })]);

    k.tick(); // segment 90 not active yet → queued + requested
    assert.ok(RawMemory._active.includes(90));
    assert.equal(w.segStore[90], undefined);
    w.nextTick();
    k.tick(); // active now → written
    w.nextTick();

    const payload = JSON.parse(w.segStore[90]);
    assert.equal(payload.v, 1);
    assert.equal(payload.shard, 'shard3');
    assert.equal(payload.rooms.W1N1.rcl, 3);
    assert.ok(payload.cpu.byProcess.some(([id]) => id === 'work'));
    assert.ok(payload.history.length >= 1);
    assert.ok(w.segStore[90].length < 100 * 1024);
});

test('pixel: generated only with a full bucket, no burst pending, and enabled', (t) => {
    const w = setup({ bucket: 10000 });
    t.after(() => w.restore());
    const pixel = require('../src/processes/report/pixel');
    const config = require('../src/config');
    const ctx = (over) => Object.assign({
        cpu: { bucket: Game.cpu.bucket },
        kernel: { burstPending: false },
        config: config.get()
    }, over);

    pixel.run(ctx({ kernel: { burstPending: true } }));
    assert.equal(Game.cpu.pixelsGenerated, 0, 'waits for the burst job');

    config.set('pixel.enabled', false);
    pixel.run(ctx());
    assert.equal(Game.cpu.pixelsGenerated, 0, 'disabled by config');
    config.set('pixel.enabled', true);

    pixel.run(ctx({ cpu: { bucket: 9999 } }));
    assert.equal(Game.cpu.pixelsGenerated, 0, 'bucket not full');

    pixel.run(ctx());
    assert.equal(Game.cpu.pixelsGenerated, 1);
});

test('memoryGC drops dead creeps only', (t) => {
    const w = setup({ memory: { v: 2, creeps: { alive: {}, dead: {} }, rooms: {} } });
    t.after(() => w.restore());
    Game.creeps = { alive: {} };
    require('../src/processes/sense/memoryGC').run(/** @type {any} */ ({}), undefined);
    assert.deepEqual(Object.keys(Memory.creeps), ['alive']);
});
