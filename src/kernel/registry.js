// @ts-check
'use strict';

/**
 * THE list of processes (DESIGN §5.1). One line per plugin.
 * Order here doesn't matter: the kernel sorts by phase, then priority.
 * To disable a plugin without a deploy: `config.set('processes.<id>.enabled', false)`.
 *
 * @type {import('../contracts/process').Process[]}
 */
module.exports = [
    require('../processes/sense/memoryGC'),
    require('../processes/report/stats'),
    require('../processes/report/pixel')
    // phase 1: sense.intel, sense.census, plan.missions, plan.assignment,
    //          plan.spawnPlanner, act.creeps, act.spawns, act.towers, ...
    // require('../processes/act/military'),   // shelved (DESIGN D3)
];
