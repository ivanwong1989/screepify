// @ts-check
'use strict';

const roomData = require('../services/roomData');
const matcher = require('../services/matcher');
const movement = require('../services/movement');
const jobs = require('./shared/jobs');
const { CONTINUE } = require('../contracts/task');

/**
 * Lab hauler (P12, docs/v2/LOGISTICS.md step L4). One hauler per room with
 * labs, spawned only while a lab asks for or offers something (reagents in,
 * product and wrong minerals out, boost stock). It takes matcher jobs that
 * start or end at a lab and has no rules of its own about where things go;
 * the lab bands (services/bands, roles from services/labs) decide.
 *
 * labs:<room>  archetype hauler (≤ 10 CARRY), priority 45; when nothing is
 *              left to do it parks near storage and keeps the mission while
 *              alive, but no new one is spawned.
 */

const MAX_CARRY = 10;

/** @param {Room} room */
function labIds(room) {
    return new Set(roomData.myByType(room, STRUCTURE_LAB).map(l => l.id));
}

/**
 * @param {import('../contracts/mission').PlanContext} plan
 * @param {import('../contracts/mission').Mission[]} out
 */
function generate(plan, out) {
    const { rc, census } = plan;
    const room = rc.room;
    if (!room.storage) return;
    const ids = labIds(room);
    if (ids.size === 0) return;
    const reqs = rc.requests;
    const pending = !!reqs && Object.keys(reqs.byRes).some(r => {
        const x = reqs.byRes[r];
        return x.req.concat(x.off).some(e => e.amount > 0 && ids.has(e.id));
    });
    const id = `labs:${rc.name}`;
    if (!pending && census(id).count === 0) return;
    out.push({
        id, type: 'labHaul', home: rc.name, room: rc.name, archetype: 'hauler',
        demand: { minCreeps: 1, maxCreeps: 1 }, spawn: pending ? 'mission' : false,
        bodyOpts: { maxCarry: MAX_CARRY }, priority: 45
    });
}

/** @type {import('../contracts/mission').MissionType['nextTask']} */
function nextTask(creep, m) {
    return { a: 'haul', i: m.id };
}

/**
 * Runs the lab hauler for one tick (action 'haul').
 * @param {Creep} creep
 * @returns {number}
 */
function run(creep) {
    if (jobs.job(creep)) return CONTINUE;
    if (creep.store.getUsedCapacity() > 0 && jobs.stash(creep, null)) return CONTINUE;
    const room = creep.room;
    const reqs = jobs.requestsFor(room);
    if (reqs && creep.store.getUsedCapacity() === 0) {
        const j = matcher.pick(reqs, { cap: creep.store.getFreeCapacity(), touch: labIds(room), pos: creep.pos });
        if (j) {
            jobs.commit(creep, j, reqs);
            jobs.job(creep);
            return CONTINUE;
        }
    }
    // Nothing to do: wait near storage, out of the way.
    if (room.storage && !creep.pos.inRangeTo(room.storage, 3)) movement.to(creep, room.storage, { range: 3 });
    return CONTINUE;
}

module.exports = { type: 'labHaul', generate, nextTask, run };
