// @ts-check
'use strict';

/**
 * Creep task-state machine (port of v1 tasks/exec/_helpers.updateState).
 *
 * States: 'init' → 'gathering' (filling up) ⇄ 'working' (spending), with
 * 'idle' as the switch point. Stored in creep.memory.s.
 */

/**
 * @param {Creep} creep
 * @param {ResourceConstant} [resourceType]
 * @param {{requireFull?: boolean, allowPartialWork?: boolean}} [opts]
 */
function update(creep, resourceType, opts) {
    const type = resourceType || RESOURCE_ENERGY;
    const requireFull = !!(opts && opts.requireFull);
    const allowPartialWork = !!(opts && opts.allowPartialWork);
    const used = creep.store.getUsedCapacity(type);
    const free = creep.store.getFreeCapacity(type);
    const mem = creep.memory;

    if (mem.s === 'working' && used === 0) mem.s = 'idle';
    if (mem.s === 'gathering' && free === 0) mem.s = 'idle';
    if (mem.s === 'idle' || mem.s === 'init' || !mem.s) {
        mem.s = (used > 0 && (!requireFull || free === 0 || allowPartialWork)) ? 'working' : 'gathering';
    }
}

/**
 * Releases a creep from its mission (v1 unassignMission + clearing the task).
 * @param {Creep} creep
 */
function release(creep) {
    const mem = creep.memory;
    delete mem.m;
    delete mem.s;
    delete mem.t;
}

/**
 * @template T
 * @param {string|undefined|null} id
 * @returns {T|null}
 */
function obj(id) {
    if (!id) return null;
    return /** @type {any} */ (Game.getObjectById(/** @type {Id<any>} */ (id)));
}

module.exports = { update, release, obj };
