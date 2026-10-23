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
    // SENSE
    require('../processes/sense/memoryGC'),
    require('../processes/sense/intel'),
    require('../processes/sense/census'),
    require('../processes/sense/policy'),
    require('../processes/sense/repairScan'),
    // PLAN
    require('../processes/plan/missions'),
    require('../processes/plan/assignment'),
    require('../processes/plan/construction'),
    // ACT
    require('../processes/act/defense'),
    require('../processes/act/spawns'),
    require('../processes/act/towers'),
    require('../processes/act/links'),
    require('../processes/act/creeps'),
    // REPORT
    require('../processes/report/stats'),
    require('../processes/report/pixel')
    // require('../processes/act/military'),   // shelved (DESIGN D3)
];
