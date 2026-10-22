// @ts-check
'use strict';

const scanner = require('../../processes/sense/repairScan');

/**
 * Opportunistic repair while travelling (port of v1 utils/creepOpportunisticRepair).
 *
 * A creep with WORK and more than half its energy repairs the most damaged
 * scanned structure within range 3, every other tick (staggered per creep).
 * Walls/ramparts only while UPGRADING or under attack.
 */

/** @param {string} name */
function seed(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = ((h * 31) + name.charCodeAt(i)) | 0;
    return Math.abs(h);
}

/**
 * @param {Creep} creep
 * @param {boolean} allowFortify
 * @returns {boolean} true if a repair intent was issued
 */
function tryRepair(creep, allowFortify) {
    if (creep.spawning) return false;
    if (creep.store[RESOURCE_ENERGY] <= 0.5 * creep.store.getCapacity()) return false;
    if (creep.getActiveBodyparts(WORK) <= 0) return false;
    if ((Game.time + (seed(creep.name) % 2)) % 2 !== 0) return false;
    const scan = scanner.get(creep.room.name);
    if (!scan.targets.length) return false;

    let best = null;
    let bestRatio = 1;
    for (const t of scan.targets) {
        if (Math.abs(t.x - creep.pos.x) > 3 || Math.abs(t.y - creep.pos.y) > 3) continue;
        const st = /** @type {any} */ (Game.getObjectById(/** @type {any} */ (t.id)));
        if (!st || !st.hitsMax) continue;
        if (scanner.isFort(st) && !allowFortify) continue;
        const desired = t.desiredHits;
        if (desired <= 0 || st.hits >= desired * 0.95) continue;
        const ratio = st.hits / desired;
        if (ratio < bestRatio) {
            bestRatio = ratio;
            best = st;
        }
    }
    return !!best && creep.repair(best) === OK;
}

module.exports = { tryRepair };
