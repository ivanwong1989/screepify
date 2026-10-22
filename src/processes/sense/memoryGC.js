// @ts-check
'use strict';

/**
 * Drops Memory.creeps entries of dead creeps.
 * Spawning creeps already exist in Game.creeps, so they are kept.
 * @type {import('../../contracts/process').Process}
 */
module.exports = {
    id: 'sense.memoryGC',
    phase: 'SENSE',
    scope: 'shard',
    tier: 'normal',
    priority: 10,
    every: 20,
    run() {
        for (const name in Memory.creeps) {
            if (!Game.creeps[name]) delete Memory.creeps[name];
        }
    }
};
