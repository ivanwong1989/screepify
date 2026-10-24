'use strict';

/**
 * Kernel scheduling findings (external review, 2026-10-24):
 * 1. deferred ("owed") work ran ahead of everything in its phase, so a
 *    consumer could run before the process that supplies its data;
 * 2. failure counters and quarantine were per process, not per room;
 * 3. a forced run (plan.missions after a VM reset) could still be skipped for
 *    budget, and assignment then released creeps whose mission it couldn't see.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeRoom, proc } = require('./helpers/mockGame');

const load = () => require('../src/kernel/kernel');

test('owed work keeps its place in the phase: a consumer never runs before its supplier', (t) => {
    const w = setup({ bucket: 5000, limit: 20 }); // soft limit 19
    t.after(() => w.restore());
    let published = null;
    const seen = [];
    let hogSpend = 0;
    const k = load().createKernel([
        proc({ id: 'hog', phase: 'SENSE', tier: 'critical', priority: 1, run: () => w.spend(hogSpend) }),
        proc({ id: 'supplier', phase: 'SENSE', tier: 'normal', priority: 10, run: () => { published = Game.time; w.spend(1); } }),
        proc({ id: 'consumer', phase: 'SENSE', tier: 'normal', priority: 20, run: () => { seen.push(published === Game.time); w.spend(5); } })
    ]);
    k.tick(); // measure everyone
    w.nextTick();
    hogSpend = 14; // 14 + 1 fits, + 5 doesn't: the consumer is deferred
    k.tick();
    assert.ok(k.state().owed.has('consumer'), 'consumer deferred');
    w.nextTick();
    hogSpend = 0;
    k.tick();
    assert.deepEqual(seen, [true, true], 'consumer saw this tick\'s data both times it ran');
});

test('owed work still gets the budget first, without jumping the order', (t) => {
    const w = setup({ bucket: 5000, limit: 20 });
    t.after(() => w.restore());
    const ran = [];
    const k = load().createKernel([
        proc({ id: 'early', priority: 1, run: () => { ran.push('early'); w.spend(10); } }),
        proc({ id: 'late', priority: 2, run: () => { ran.push('late'); w.spend(10); } })
    ]);
    k.tick(); // both measured (20 > 19: 'late' already over, but no estimate yet)
    w.nextTick();
    ran.length = 0;
    k.tick(); // 'early' runs, 'late' is deferred
    assert.deepEqual(ran, ['early']);
    w.nextTick();
    ran.length = 0;
    k.tick(); // the owed 'late' keeps its budget: 'early' waits this time
    assert.deepEqual(ran, ['late'], 'deferred work catches up');
});

test('failures are counted per room: a room that keeps failing is quarantined alone', (t) => {
    const w = setup({
        rooms: { W1N1: makeRoom('W1N1'), W2N2: makeRoom('W2N2') },
        memory: { v: 2, creeps: {}, rooms: {}, config: { kernel: { quarantineAfter: 3, quarantineTicks: 10 } } }
    });
    t.after(() => w.restore());
    const ran = { W1N1: 0, W2N2: 0 };
    const k = load().createKernel([
        proc({
            id: 'r', scope: 'room', run: (ctx, room) => {
                ran[room.name]++;
                if (room.name === 'W1N1') throw new Error('boom');
            }
        })
    ]);
    for (let i = 0; i < 6; i++) {
        k.tick();
        w.nextTick();
    }
    assert.equal(ran.W1N1, 3, 'failing room stops after 3 (success elsewhere does not reset it)');
    assert.equal(ran.W2N2, 6, 'healthy room keeps running');
    assert.ok(w.logs.some(l => /quarantined/.test(l) && /W1N1/.test(l)));
});

test('a forced run is never skipped for budget', (t) => {
    const w = setup({ rooms: { W1N1: makeRoom('W1N1') }, bucket: 5000, limit: 20 });
    t.after(() => w.restore());
    let planned = 0;
    let need = true;
    const k = load().createKernel([
        proc({ id: 'hog', scope: 'room', tier: 'critical', priority: 1, run: () => w.spend(30) }),
        proc({ id: 'plan', scope: 'room', tier: 'normal', priority: 10, every: 1000, force: () => need, run: () => { planned++; w.spend(2); } })
    ]);
    k.tick();
    w.nextTick();
    k.tick(); // over budget, but forced
    assert.equal(planned, 2, 'forced run happened under CPU pressure');
    need = false;
});

test('low-tier work blocked by the bucket floor reserves no budget', (t) => {
    const w = setup({ bucket: 5000, limit: 20 });
    t.after(() => w.restore());
    const ran = [];
    const k = load().createKernel([
        proc({ id: 'normal', priority: 1, run: () => { ran.push('normal'); w.spend(10); } }),
        proc({ id: 'low', tier: 'low', priority: 2, run: () => { ran.push('low'); w.spend(10); } })
    ]);
    k.tick(); // both measured
    w.nextTick();
    Game.cpu.bucket = 500; // below the low floor: 'low' is blocked and owed
    for (let i = 0; i < 3; i++) {
        ran.length = 0;
        k.tick();
        w.nextTick();
        assert.deepEqual(ran, ['normal'], `tick ${i}: normal work not held back for blocked low work`);
    }
});
