// @ts-check
'use strict';

const laneStore = require('./laneStore');
const policyRules = require('./policyRules');

/**
 * Which targets the lane haulers own this tick. `sense.lanes` publishes the
 * result as `rc.lanes`; logistics and fleet read it there instead of asking
 * the lane missions, so mission types don't import each other.
 *
 * @typedef {{core: Set<string>|null, mining: Set<string>}} LaneClaims
 *   core    spawns/extensions/towers (and head link) the core lane hauler fills,
 *           or null when the lane isn't running
 *   mining  mining containers whose mining lane has a live hauler
 */

/** Storage energy below which logistics also refills the lane targets. */
const STORAGE_MIN = 1000;

/** Live lane haulers homed in the room. @param {import('../contracts/ctx').RoomCtx} rc */
function coreHaulers(rc) {
    const list = rc.census && rc.census.byArchetype.laneHauler;
    return list ? list.filter(c => !c.spawning) : [];
}

/**
 * Targets the lane hauler serves right now, or null when the lane isn't
 * running (logistics then keeps its own supply missions for them).
 * @param {import('../contracts/ctx').RoomCtx} rc
 * @returns {Set<string>|null}
 */
function core(rc) {
    if (coreHaulers(rc).length === 0) return null;
    // With storage nearly empty the lane hauler has nothing to carry; let the
    // fleet refill spawns/extensions straight from mining.
    const storage = rc.room.storage;
    if (!storage || storage.store[RESOURCE_ENERGY] < STORAGE_MIN) return null;
    const lane = laneStore.get(rc.room);
    return lane ? lane.covered : null;
}

/** Mining lanes may run in this room. @param {import('../contracts/ctx').RoomCtx} rc */
function miningEnabled(rc) {
    const room = rc.room;
    if (!require('../config').get().lanes.mining) return false;
    if (!room.controller || !room.controller.my) return false;
    if (!policyRules.atLeast(rc.policy, 'STORAGE') || (rc.policy && rc.policy.state === 'CRITICAL')) return false;
    return true;
}

/** @param {import('../contracts/ctx').RoomCtx} rc @param {string} id */
function liveCount(rc, id) {
    const t = rc.census && rc.census.byMission[id];
    return t ? t.count : 0;
}

/**
 * Mining containers whose lane has a live hauler (fleet/logistics skip them).
 * @param {import('../contracts/ctx').RoomCtx} rc
 * @returns {Set<string>}
 */
function mining(rc) {
    /** @type {Set<string>} */
    const out = new Set();
    if (!rc.intel || !miningEnabled(rc)) return out;
    for (const s of rc.intel.sources) {
        if (s.containerId && liveCount(rc, `mlane:${s.id}`) > 0) out.add(s.containerId);
    }
    return out;
}

/**
 * Claims as published on ctx, or computed when a caller runs without the
 * SENSE phase (tests, console).
 * @param {import('../contracts/ctx').RoomCtx} rc
 * @returns {LaneClaims}
 */
function of(rc) {
    return rc.lanes || { core: core(rc), mining: mining(rc) };
}

module.exports = { core, mining, of, coreHaulers, miningEnabled, liveCount, STORAGE_MIN };
