// @ts-check
'use strict';

/**
 * Mission registry (DESIGN §8).
 *
 * `generators` run in this order every planning pass (v1 order, economy only);
 * `executors` map a mission type to the module whose nextTask() drives creeps.
 * Adding a mission type = one module + one line in each list that applies.
 */

const tower = require('./tower');
const harvest = require('./harvest');
const fleet = require('./fleet');
const logistics = require('./logistics');
const repair = require('./repair');
const fortify = require('./fortify');
const upgrade = require('./upgrade');
const build = require('./build');
const decongest = require('./decongest');
const transfer = require('./transfer');
const coreLane = require('./coreLane');
const miningLane = require('./miningLane');

/** @typedef {(plan: import('../contracts/mission').PlanContext, out: import('../contracts/mission').Mission[]) => void} Generator */

/**
 * `key` (optional): extra state that forces this generator to refresh as soon
 * as it changes, on top of the planner's room key (plan/missions.js).
 * Refresh intervals per name: config.missions.every.
 * @type {Array<{name: string, generate: Generator, key?: (plan: import('../contracts/mission').PlanContext) => string}>}
 */
const generators = [
    { name: 'tower', generate: tower.generate },
    // phase 2: scout, remote build/harvest/haul, reserve, claim, move2flag
    { name: 'harvest', generate: harvest.generate },
    // phase 2: mineral
    { name: 'miningLane', generate: miningLane.generate },
    { name: 'fleet', generate: fleet.generate, key: p => `${miningLane.covered(p.rc).size}` },
    { name: 'coreLane', generate: coreLane.generate },
    // Refill missions must appear as soon as spawning empties the extensions,
    // and come back at once if the lane hauler dies.
    {
        name: 'logistics', generate: logistics.generate,
        key: p => `${p.intel.energyAvailable < p.intel.energyCapacityAvailable ? 'refill' : 'full'}:` +
            `${coreLane.covered(p.rc) ? 'lane' : '-'}:${miningLane.covered(p.rc).size}`
    },
    // phase 2: labs
    { name: 'repair', generate: repair.generate },
    { name: 'fortify', generate: fortify.generate },
    { name: 'upgrade', generate: upgrade.generate },
    { name: 'build', generate: build.generate },
    { name: 'decongest', generate: decongest.generate },
    // phase 2: user dismantle / transfer
    { name: 'idleUpgrade', generate: upgrade.generateIdle }
];

/** @type {Record<string, import('../contracts/mission').MissionType['nextTask']>} */
const executors = {
    harvest: harvest.nextTask,
    transfer: transfer.nextTask,
    upgrade: upgrade.nextTask,
    build: build.nextTask,
    repair: repair.nextTask,
    fortify: fortify.nextTask,
    decongest: decongest.nextTask,
    coreLane: coreLane.nextTask,
    miningLane: miningLane.nextTask
};

/** Mission types creeps are never assigned to (spawn-only or structure-driven). */
const UNASSIGNABLE = new Set(['hauler_fleet', 'tower_attack', 'tower_heal', 'tower_repair']);

/** Body parts a mission type needs (v1 getMissionNeeds). */
/** @param {string} type */
function needs(type) {
    if (type === 'harvest' || type === 'mineral' || type === 'dismantle') return { work: true, carry: false, claim: false };
    if (type === 'upgrade' || type === 'build' || type === 'repair' || type === 'fortify') return { work: true, carry: true, claim: false };
    if (type === 'transfer' || type === 'coreLane' || type === 'miningLane') return { work: false, carry: true, claim: false };
    if (type === 'reserve' || type === 'claim') return { work: false, carry: false, claim: true };
    return { work: false, carry: false, claim: false };
}

module.exports = { generators, executors, UNASSIGNABLE, needs };
