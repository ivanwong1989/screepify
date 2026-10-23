'use strict';

/**
 * Mission planning cadence (plan.missions): each generator refreshes on its
 * own interval and reuses its last output in between.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/runSim');

test('generators refresh on their own interval, room changes force a refresh', () => {
    const sim = boot(undefined, { deterministic: true, config: { construction: { enabled: false }, missions: { every: { harvest: 1000 } } } });
    sim.run(400);
    const cache = require('../src/services/cache');
    const config = require('../src/config');
    const gens = cache.store('plan.generators').W1N1;
    const every = config.get().missions.every;
    for (const name of ['upgrade', 'tower']) {
        assert.ok(gens[name], `${name} ran`);
        assert.ok(Game.time - gens[name].t < every[name] + 2, `${name} refreshed within ${every[name]} ticks`);
    }
    // Missions from every generator are still published between refreshes.
    sim.run(1);
    const ids = cache.store('room.missions').W1N1.list.map(m => m.id);
    assert.ok(ids.includes('upgrade:controller'));
    assert.ok(ids.some(id => id.startsWith('harvest:')));

    // Harvest (every 1000) is reused while nothing changes...
    const before = gens.harvest.t;
    sim.run(20);
    assert.equal(cache.store('plan.generators').W1N1.harvest.t, before, 'harvest reused');
    // ...and a policy change refreshes everything at the next planning pass.
    Memory.rooms.W1N1.po = 'STOCKPILE';
    sim.run(3);
    assert.ok(cache.store('plan.generators').W1N1.harvest.t > before, 'harvest refreshed on policy change');
});
