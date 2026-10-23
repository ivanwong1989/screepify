// @ts-check
'use strict';

const traffic = require('../../services/traffic');

/**
 * Resolves creep traffic once per room, after every creep has acted
 * (services/traffic). Shard scope: creeps act under their home room's
 * act.creeps, but they block each other in the room they stand in.
 */

/** @type {import('../../contracts/process').Process} */
module.exports = {
    id: 'act.traffic',
    phase: 'ACT',
    scope: 'shard',
    tier: 'critical',
    priority: 60,
    run(ctx) {
        if (!ctx.config.traffic.enabled) return;
        for (const name of traffic.rooms()) {
            const room = Game.rooms[name];
            if (room) traffic.resolve(room);
        }
    }
};
