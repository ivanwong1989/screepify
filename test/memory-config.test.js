'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/mockGame');

test('v1 → v2 migration wipes everything but config, and is idempotent', (t) => {
    const w = setup({
        memory: { creeps: { a: { role: 'miner' } }, rooms: { W1N1: { overseer: {} } }, military: {}, config: { pixel: { enabled: false } } }
    });
    t.after(() => w.restore());
    const memory = require('../src/kernel/memory');
    const ran = memory.migrate(Memory);
    assert.equal(ran.length, 1);
    assert.deepEqual(Memory, { v: 2, config: { pixel: { enabled: false } }, creeps: {}, rooms: {}, flags: {}, spawns: {} });
    assert.deepEqual(memory.migrate(Memory), []);
    assert.ok(memory.isCurrent(Memory));
});

test('a newer schema is left untouched', (t) => {
    const w = setup({ memory: { v: 99, keep: true } });
    t.after(() => w.restore());
    const memory = require('../src/kernel/memory');
    assert.deepEqual(memory.migrate(Memory), []);
    assert.equal(Memory.keep, true);
    assert.equal(Memory.v, 99);
});

test('config merges defaults < Memory.config < shard defaults < shard overrides', (t) => {
    const w = setup({
        shard: 'shard3',
        memory: { config: { stats: { segment: 50 }, shards: { shard3: { pixel: { enabled: false } }, shard1: { stats: { segment: 1 } } } } }
    });
    t.after(() => w.restore());
    const config = require('../src/config');
    config.DEFAULTS.shards.shard3 = { stats: { history: 7 } };
    const cfg = config.load();
    assert.equal(cfg.stats.segment, 50);
    assert.equal(cfg.stats.history, 7);
    assert.equal(cfg.stats.topProcesses, 10);
    assert.equal(cfg.pixel.enabled, false);
    delete config.DEFAULTS.shards.shard3;
});

test('config.set / reset handle process ids with dots', (t) => {
    const w = setup();
    t.after(() => w.restore());
    const config = require('../src/config');
    config.set('processes.report.stats.enabled', false);
    assert.deepEqual(Memory.config, { processes: { 'report.stats': { enabled: false } } });
    assert.equal(config.get().processes['report.stats'].enabled, false);
    config.reset('processes.report.stats.enabled');
    assert.equal(config.get().processes['report.stats'].enabled, undefined);
    config.set('pixel.enabled', false);
    assert.equal(config.get().pixel.enabled, false);
});
