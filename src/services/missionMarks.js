// @ts-check
'use strict';

/**
 * Missions found finished (docs: live 2026-10-24). When a creep's mission type
 * returns no task, the mission stays listed until its generator refreshes it
 * (up to 25 ticks), still looks short of creeps, and keeps catching and
 * dropping the same creep while also counting toward pool spawning.
 *
 * act.creeps marks the mission object here; plan.assignment and act.spawns
 * skip marked ones. The mark lives on the object: a refreshed generator emits
 * new objects, which start unmarked, so a mission with real work again is
 * picked up as normal. Only shared missions (pool or no spawning) are marked;
 * a mission with its own spawn slots (harvest, lanes) belongs to its creeps.
 */

/** @type {WeakSet<object>} */
let done = new WeakSet();

/** @param {import('../contracts/mission').Mission} m */
function markFinished(m) {
    if (m && (m.spawn === 'pool' || m.spawn === false)) done.add(m);
}

/** @param {import('../contracts/mission').Mission} m */
function isFinished(m) {
    return !!m && done.has(m);
}

/** Tests only. */
function reset() {
    done = new WeakSet();
}

module.exports = { markFinished, isFinished, reset };
