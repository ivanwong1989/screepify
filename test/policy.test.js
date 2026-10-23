'use strict';

/**
 * Room policy (sense.policy): phase and state rules ported from v1
 * dev_make_missions_missions, and how upgrade/fortify react to them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createWorld } = require('./helpers/sim');
const { boot, DEFAULT_ROOM } = require('./helpers/runSim');

const ROOT = path.join(__dirname, '..');
function fresh() {
    createWorld(DEFAULT_ROOM);
    for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'src'))) delete require.cache[k];
    delete global.__v2heap;
    return require('../src/processes/sense/policy');
}

const CFG = { stockpileTargets: { 4: 50000 }, stockpileHysteresis: 0.1 };

/** A healthy RCL 4 room with storage; override fields per test. */
const facts = (o) => Object.assign({
    hasSpawn: true, sourceCount: 2, sourceContainers: 2, sourceLinks: 0, otherContainers: 1,
    links: 0, controllerLink: false, labs: 0, extensions: 20, hasStorage: true, hasTerminal: false,
    rcl: 4, storageEnergy: 80000, energyAvailable: 1300, energyCapacity: 1300,
    creeps: 12, miners: 2, haulers: 3, threats: 0
}, o);

/** @param {any} policy @param {object} f @param {string} [prev] */
const state = (policy, f, prev) => policy.deriveState(facts(f), prev, CFG, []);

test('phase follows infrastructure (v1 order)', () => {
    const policy = fresh();
    const none = { sourceContainers: 0, otherContainers: 0, hasStorage: false };
    assert.equal(policy.derivePhase(facts({ hasSpawn: false })), 'BOOTSTRAP');
    assert.equal(policy.derivePhase(facts(none)), 'BOOTSTRAP');
    assert.equal(policy.derivePhase(facts({ ...none, sourceContainers: 1 })), 'EARLY');
    assert.equal(policy.derivePhase(facts({ hasStorage: false, sourceContainers: 1 })), 'EARLY', '1 of 2 sources < 75%');
    assert.equal(policy.derivePhase(facts({ hasStorage: false })), 'BASIC_INFRA');
    assert.equal(policy.derivePhase(facts({})), 'STORAGE');
    assert.equal(policy.derivePhase(facts({ links: 2 })), 'STORAGE', 'links not at a source/controller');
    assert.equal(policy.derivePhase(facts({ links: 2, sourceLinks: 1 })), 'LINKS');
    assert.equal(policy.derivePhase(facts({ links: 2, controllerLink: true })), 'LINKS');
    assert.equal(policy.derivePhase(facts({ hasTerminal: true })), 'TERMINAL');
    assert.equal(policy.derivePhase(facts({ labs: 3, hasTerminal: true })), 'LABS');
    assert.ok(policy.atLeast({ phase: 'LINKS' }, 'STORAGE'));
    assert.ok(!policy.atLeast({ phase: 'EARLY' }, 'STORAGE'));
    assert.ok(!policy.atLeast(undefined, 'BOOTSTRAP'));
});

test('state: threats, then survival, then recovery', () => {
    const policy = fresh();
    assert.equal(state(policy, { threats: 1, creeps: 0 }), 'DEFENSIVE', 'threat wins');
    assert.equal(state(policy, { creeps: 0 }), 'CRITICAL');
    assert.equal(state(policy, { miners: 0 }), 'CRITICAL');
    assert.equal(state(policy, { creeps: 1, energyAvailable: 200 }), 'CRITICAL');
    assert.equal(state(policy, { creeps: 2 }), 'RECOVER');
    assert.equal(state(policy, { haulers: 0 }), 'RECOVER');
    assert.equal(state(policy, { energyAvailable: 300 }), 'RECOVER', '300 < 35% of 1300');
    assert.equal(state(policy, { energyAvailable: 200, energyCapacity: 300, extensions: 0 }), 'GROW',
        'no extensions: low spawn energy is normal, not RECOVER');
    assert.equal(state(policy, {}), 'GROW');
});

test('state: stockpile hysteresis (±10% of the RCL target)', () => {
    const policy = fresh();
    assert.equal(state(policy, { storageEnergy: 46000 }), 'GROW', 'above 45k, not stockpiling yet');
    assert.equal(state(policy, { storageEnergy: 45000 }), 'STOCKPILE', 'enter at 45k');
    assert.equal(state(policy, { storageEnergy: 54000 }, 'STOCKPILE'), 'STOCKPILE', 'hold below 55k');
    assert.equal(state(policy, { storageEnergy: 55000 }, 'STOCKPILE'), 'GROW', 'release at 55k');
    assert.equal(state(policy, { storageEnergy: 0, rcl: 2 }), 'GROW', 'no target at RCL 2');
    assert.equal(state(policy, { storageEnergy: 0, hasStorage: false }), 'GROW');
});

test('upgrade and fortify follow the policy state', () => {
    fresh();
    const upgrade = require('../src/missions/upgrade');
    const repair = require('../src/missions/repair');
    const room = Game.rooms.W1N1;
    const intel = {
        controller: room.controller, sites: [], availableControllerSpaces: 8, energySourceIds: [],
        hostiles: []
    };
    const gen = (ps, phase = 'STORAGE') => {
        const out = [];
        upgrade.generate({
            rc: { name: 'W1N1', room }, intel, state: { op: 'NORMAL', economy: 'UPGRADING' },
            policy: { phase, state: ps, reasons: [] }, census: () => ({ count: 2, work: 4, carry: 2 })
        }, out);
        return out[0];
    };
    assert.equal(gen('GROW').demand.work, 15);
    assert.equal(gen('GROW').spawn, 'pool');
    assert.equal(gen('RECOVER').demand.work, 1);
    assert.equal(gen('DEFENSIVE').demand.work, 1);
    const stock = gen('STOCKPILE');
    assert.equal(stock.spawn, false, 'STOCKPILE spawns no upgraders');
    assert.deepEqual([stock.demand.minCreeps, stock.demand.maxCreeps], [2, 2], 'but keeps the 2 it has');
    assert.equal(gen('CRITICAL').spawn, false);

    const mode = (st, phase = 'STORAGE') => repair.fortifyMode({ phase, state: st, reasons: [] });
    assert.equal(mode('GROW'), 'on');
    assert.equal(mode('GROW', 'BASIC_INFRA'), 'off', 'no fortifying before storage');
    assert.equal(mode('RECOVER'), 'noSpawn');
    assert.equal(mode('STOCKPILE'), 'off');
    assert.equal(mode('CRITICAL'), 'off');
    assert.equal(mode('DEFENSIVE', 'EARLY'), 'on', 'always under threat');
    assert.equal(mode(undefined), 'on');
});

test('sim: policy is published every tick, override sticks', () => {
    const sim = boot(undefined, { deterministic: true });
    sim.run(5);
    const cache = require('../src/services/cache');
    const last = cache.store('policy.last').W1N1;
    assert.ok(last, 'policy written');
    assert.equal(last.phase, 'BOOTSTRAP');
    assert.ok(['CRITICAL', 'RECOVER'].includes(last.state), `fresh room state ${last.state}`);
    Memory.rooms.W1N1.po = 'stockpile';
    sim.run(1);
    assert.equal(cache.store('policy.last').W1N1.state, 'STOCKPILE');
});
