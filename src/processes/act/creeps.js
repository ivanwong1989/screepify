// @ts-check
'use strict';

const log = require('../../services/log');
const cache = require('../../services/cache');
const actions = require('../../actions/index');
const registry = require('../../missions/index');
const state = require('../../missions/shared/state');
const oppRepair = require('../../missions/shared/oppRepair');
const policyRules = require('../../services/policyRules');
const missionMarks = require('../../services/missionMarks');
const jobs = require('../../missions/shared/jobs');
const { CONTINUE, DONE } = require('../../contracts/task');

/**
 * Creep runner (DESIGN §9.2).
 *
 * Tasks stick until finished. Only then does the mission type plan the next
 * task — most ticks a creep costs one action call, not a re-evaluation of
 * every option like v1's per-tick tasker.
 */

const MAX_STEPS = 3;
/** Ticks without a mission before an idle creep puts its cargo away. */
const IDLE_STASH = 5;

/**
 * @param {Creep} creep
 * @param {import('../../contracts/ctx').RoomCtx} rc
 * @param {import('../../contracts/ctx').TickContext} ctx
 */
function runCreep(creep, rc, ctx) {
    const mem = creep.memory;
    const mission = mem.m && rc.missionsById ? rc.missionsById[mem.m] : null;
    const exec = mission ? registry.executors[mission.type] : null;
    let task = mem.t || null;
    let triedRepair = false;

    // Still without a mission after IDLE_STASH ticks: a hauler (or anyone
    // holding minerals) puts its cargo away where the request list wants it,
    // usually storage, instead of carrying it around (live: an idle hauler
    // sat on 1,100 energy). Workers keep energy for their next mission.
    // Assignment clears the job when it hands out a mission.
    const idle = cache.store('creep.idleSince');
    if (mission || task || mem.m) {
        // (A mission id with no mission object: the list is missing this
        // tick, e.g. planning was skipped. Not idle; wait for it.)
        delete idle[creep.name];
        if (!mission && !task) return;
    } else {
        if (idle[creep.name] === undefined) idle[creep.name] = Game.time;
        const minerals = creep.store.getUsedCapacity() > (creep.store[RESOURCE_ENERGY] || 0);
        if (/** @type {any} */ (mem).j || (Game.time - idle[creep.name] >= IDLE_STASH &&
            (mem.a === 'hauler' || minerals) && creep.store.getUsedCapacity() > 0)) {
            jobs.stash(creep, null);
        }
        return;
    }

    for (let step = 0; step < MAX_STEPS; step++) {
        if (!task) {
            if (!exec || !mission) return;
            task = exec(creep, mission, rc, ctx);
            if (!task) {
                // Nothing left to do on it: don't let assignment hand it out
                // again until it's refreshed (services/missionMarks).
                missionMarks.markFinished(mission);
                state.release(creep);
                return;
            }
            mem.t = task;
        }
        if (!triedRepair && !actions.WORK_PIPE.has(task.a)) {
            triedRepair = true;
            const allowFortify = policyRules.fortifyMode(rc.policy) !== 'off' ||
                !!(rc.intel && rc.intel.hostiles.length > 0);
            oppRepair.tryRepair(creep, allowFortify);
        }

        const prev = task.a;
        const r = actions.run(creep, task);
        if (r === CONTINUE) return;
        delete mem.t;
        task = null;
        if (r !== DONE) continue;

        if (!exec || !mission) return;
        const next = exec(creep, mission, rc, ctx);
        if (!next) {
            missionMarks.markFinished(mission);
            state.release(creep);
            return;
        }
        mem.t = next;
        if (actions.followUp(creep, prev, next) !== CONTINUE) delete mem.t;
        return;
    }
}

/** @type {import('../../contracts/process').Process} */
module.exports = {
    id: 'act.creeps',
    phase: 'ACT',
    scope: 'room',
    kinds: ['owned', 'bootstrap'],
    tier: 'critical',
    priority: 50,
    run(ctx, rc) {
        if (!rc.census) return;
        for (const creep of rc.census.active) {
            try {
                runCreep(creep, rc, ctx);
            } catch (e) {
                log.throttled(`creep:${creep.name}`, 100, () =>
                    log.error(`creep ${creep.name} failed:`, (e && /** @type {any} */ (e).stack) || e));
            }
        }
    }
};
