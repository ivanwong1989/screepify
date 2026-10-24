'use strict';

/**
 * Idle general haulers (live 2026-10-24). With mining lanes running, the fleet
 * kept one general hauler per room at all times, idle most of its life (~2.7
 * energy per tick per room at RCL 8). Now it keeps one only while there's
 * off-lane hauling work, and an idle hauler puts its cargo away.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/runSim');

function laneRoom() {
    const sim = boot({ spawn: [24, 20], sources: [[5, 5], [44, 44]], controller: [10, 40] }, {
        deterministic: true, config: { construction: { enabled: false } }
    });
    const w = sim.world;
    w.controller.level = 6;
    const storage = w.addStructure('storage', 26, 20);
    storage.store.energy = 300000;
    w.addStructure('container', 6, 6);
    w.addStructure('container', 43, 43);
    return Object.assign(sim, { w, storage });
}
const fleet = () => Object.values(Game.creeps).filter(c => c.memory.a === 'hauler');

test('fleet floor: one general hauler only while there was off-lane work recently', () => {
    laneRoom();
    const { floor } = require('../src/missions/fleet');
    assert.equal(floor(true, 0, 2, true), 1, 'lanes cover all, recent off-lane work: keep one');
    assert.equal(floor(true, 0, 2, false), 0, 'lanes cover all, nothing to do: none (was 1)');
    assert.equal(floor(true, 1, 2, false), 1, 'a source without a lane hauler still needs the fleet');
    assert.equal(floor(false, 2, 2, false), 2, 'no lanes yet: v1 floor');
    const haulDemand = require('../src/services/haulDemand');
    haulDemand.note('W1N1');
    assert.equal(haulDemand.recent('W1N1', 300), true);
    Game.time += 301;
    assert.equal(haulDemand.recent('W1N1', 300), false, 'forgotten after the window');
});

test('sim: a hauler without a mission puts its cargo away where it is wanted', () => {
    const sim = laneRoom();
    sim.run(1000);
    const h = fleet().find(c => !c.spawning);
    assert.ok(h, 'a fleet hauler');
    // Keep it without a mission: no assignment, mission and task cleared.
    require('../src/config').set('processes.plan.assignment.enabled', false);
    delete h.memory.m;
    delete h.memory.t;
    delete h.memory.j;
    h.store.energy = Math.min(200, h.store.getCapacity());
    sim.w.carryLog = [];
    for (let i = 0; i < 60 && (h.store.energy || 0) > 0; i++) sim.run(1);
    assert.equal(h.store.energy || 0, 0, 'cargo put away');
    // Delivered where the request list wanted it (spawn/extensions first, else storage).
    const into = sim.w.carryLog.filter(e => e.creep === h.name && e.a === 'transfer');
    assert.ok(into.length > 0 && into.reduce((t, e) => t + e.n, 0) >= 150, JSON.stringify(into));
});
