'use strict';

// Offline source-pipeline replay. No network access or live game writes.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { replayWorld } = require('../test/helpers/miningReplay');
const results = [];
for (const room of ['W43S28', 'W44S28', 'W44S29']) {
    const fixture = require(`../test/fixtures/mining/${room}.json`);
    const sim = replayWorld(fixture);
    const start = Game.time;
    const storageBefore = sim.world.room.storage.store.energy;
    sim.run(120);
    for (const source of sim.world.sources) {
        const health = require('../src/services/miningHealth').snapshot(room)[source.id];
        assert.ok(sim.bySource[source.id] > 0, `${room} ${source.id}: no energy harvested`);
        results.push({ room, source: source.id, ticks: 120, firstHarvestAfter: sim.firstHarvest[source.id] - start,
            harvested: sim.bySource[source.id], owner: health.owner, reason: health.reason,
            storageDeltaRoom: sim.world.room.storage.store.energy - storageBefore });
    }
}
const report = { snapshot: '2026-10-31 ~08:32 MYT', scope: 'Source pipeline in local simulator; real terrain, structures, miner bodies and bindings. Simulator omits fatigue and full game-engine behavior; no claim about production CPU.', results };
console.table(results);
const output = process.argv[2];
if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
