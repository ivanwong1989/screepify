// @ts-check
'use strict';

const scanner = require('../../services/repairScan');

/**
 * Runs the repair scan (services/repairScan) for each room: every 7 ticks,
 * every tick while hostiles are present or something is critical.
 */

/** @type {import('../../contracts/process').Process} */
module.exports = {
    id: 'sense.repairScan',
    phase: 'SENSE',
    scope: 'room',
    kinds: ['owned', 'bootstrap'],
    tier: 'normal',
    priority: 30,
    run(ctx, rc) {
        const prev = scanner.get(rc.name);
        const hostiles = rc.intel ? rc.intel.hostiles.length > 0 : false;
        scanner.scan(rc.room, { force: hostiles || prev.critical });
    }
};
