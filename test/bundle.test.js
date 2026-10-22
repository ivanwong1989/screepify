'use strict';

/**
 * Smoke test of the real bundle: build dist/main.js, load it in a fresh VM
 * context the way the game would, and run ticks.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { build } = require('../scripts/build');
const { setup, makeRoom } = require('./helpers/mockGame');

test('bundle loads, migrates Memory, runs ticks and exports stats', async (t) => {
    await build();
    const code = fs.readFileSync(path.join(__dirname, '..', 'dist', 'main.js'), 'utf8');

    const w = setup({
        bucket: 10000,
        rooms: { W1N1: makeRoom('W1N1') },
        memory: { military: {}, creeps: { gone: {} } }
    });
    t.after(() => w.restore());

    const mod = { exports: {} };
    const sandbox = {
        module: mod,
        exports: mod.exports,
        console,
        Game: global.Game,
        Memory: global.Memory,
        RawMemory: global.RawMemory,
        OK: 0,
        RESOURCE_ENERGY: 'energy'
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    assert.equal(typeof mod.exports.loop, 'function');
    assert.equal(typeof sandbox.stats, 'function', 'console commands registered');

    for (let i = 0; i < 45; i++) {
        mod.exports.loop();
        w.nextTick();
    }

    assert.equal(sandbox.Memory.v, 2);
    assert.equal(sandbox.Memory.military, undefined);
    assert.equal(Game.cpu.pixelsGenerated, 1, 'full bucket → one pixel');
    assert.ok(w.segStore[90], 'stats segment written');
    assert.match(sandbox.stats(), /CPU avg/);
    assert.match(sandbox.proc.list(), /report\.stats/);
});
