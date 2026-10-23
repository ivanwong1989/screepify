// @ts-check
'use strict';

const cache = require('./cache');
const roomData = require('./roomData');

/**
 * Repair scanner rules and results (port of v1 overseer.opportunistic.repair).
 * `sense.repairScan` runs the scan; missions read the result through get().
 *
 * Every 7 ticks (staggered per room; every tick while hostiles are present or
 * something is critical) one pass over the room's structures produces:
 * - targets:   damaged structures for opportunistic repair by passing creeps
 * - repairIds: repair work, roads/containers first, then other, then critical walls
 * - fortifyIds: walls/ramparts to raise toward the RCL fortify target
 */

const SCAN_INTERVAL = 7;
const MIN_DAMAGE_RATIO = 0.95;
const MAX_TARGETS = 120;
const REPAIR_MIN_RATIO = 0.9;
const CRITICAL_GENERAL_RATIO = 0.8;
const CRITICAL_DECAYABLE_RATIO = 0.7;
const CRITICAL_WALL_HITS = 5000;
const FORTIFY = {
    0: { start: 0, target: 0 },
    1: { start: 0, target: 0 },
    2: { start: 10000, target: 20000 },
    3: { start: 20000, target: 150000 },
    4: { start: 150000, target: 300000 },
    5: { start: 300000, target: 500000 },
    6: { start: 900000, target: 1300000 },
    7: { start: 3000000, target: 3500000 },
    8: { start: 3500000, target: 5000000 }
};

/**
 * @typedef {{id: string, x: number, y: number, desiredHits: number, ratio: number}} OppTarget
 * @typedef {{lastScan: number, targets: OppTarget[], repairIds: string[], fortifyIds: string[], critical: boolean}} RoomScan
 */

/** @param {Room} room */
function fortifyPolicy(room) {
    const rcl = room.controller ? room.controller.level : 0;
    return FORTIFY[rcl] || FORTIFY[0];
}

/** @param {any} st */
function isFort(st) {
    return st.structureType === STRUCTURE_WALL || st.structureType === STRUCTURE_RAMPART;
}

/** @param {any} st */
function isCritical(st) {
    if (!st || !st.hitsMax) return false;
    if (isFort(st)) return st.hits < CRITICAL_WALL_HITS;
    if (st.structureType === STRUCTURE_ROAD || st.structureType === STRUCTURE_CONTAINER) {
        return st.hits < st.hitsMax * CRITICAL_DECAYABLE_RATIO;
    }
    return st.hits < st.hitsMax * CRITICAL_GENERAL_RATIO;
}

/** @param {any} st */
function needsRepair(st) {
    if (!st || !st.hitsMax || isFort(st)) return false;
    return st.hits < st.hitsMax * REPAIR_MIN_RATIO;
}

/**
 * @param {Room} room
 * @param {any} st
 */
function desiredHits(room, st) {
    if (isFort(st)) {
        const target = fortifyPolicy(room).target;
        return target > 0 ? Math.min(target, st.hitsMax) : 0;
    }
    return st.hitsMax;
}

/**
 * @param {string} roomName
 * @returns {RoomScan}
 */
function get(roomName) {
    const store = cache.store('repair.scan');
    return store[roomName] || (store[roomName] = { lastScan: 0, targets: [], repairIds: [], fortifyIds: [], critical: false });
}

/**
 * @param {Room} room
 * @param {{force?: boolean}} [opts]
 */
function scan(room, opts) {
    const rs = get(room.name);
    const due = !rs.lastScan || Game.time - rs.lastScan >= SCAN_INTERVAL;
    if (!(opts && opts.force) && !due) return rs;

    const prevFort = new Set(rs.fortifyIds);
    const policy = fortifyPolicy(room);
    /** @type {OppTarget[]} */
    const targets = [];
    const repair = [];
    const fortify = [];
    let critical = false;

    for (const st of roomData.structures(room)) {
        const s = /** @type {any} */ (st);
        if (!s.hitsMax) continue;
        const desired = desiredHits(room, s);
        if (desired > 0 && s.hits < desired * MIN_DAMAGE_RATIO) {
            targets.push({ id: s.id, x: s.pos.x, y: s.pos.y, desiredHits: desired, ratio: s.hits / desired });
        }
        if (isFort(s)) {
            if (policy.target <= 0) continue;
            const active = s.hits < policy.start || (prevFort.has(s.id) && s.hits < policy.target);
            if (!active) continue;
            const ratio = s.hits / policy.target;
            if (isCritical(s)) {
                critical = true;
                repair.push({ id: s.id, ratio, group: 2 });
            } else {
                fortify.push({ id: s.id, ratio });
            }
            continue;
        }
        if (needsRepair(s)) {
            if (isCritical(s)) critical = true;
            const group = (s.structureType === STRUCTURE_ROAD || s.structureType === STRUCTURE_CONTAINER) ? 0 : 1;
            repair.push({ id: s.id, ratio: s.hits / s.hitsMax, group });
        }
    }

    targets.sort((a, b) => a.ratio - b.ratio);
    repair.sort((a, b) => (a.group - b.group) || (a.ratio - b.ratio));
    fortify.sort((a, b) => a.ratio - b.ratio);
    rs.targets = targets.slice(0, MAX_TARGETS);
    rs.repairIds = repair.map(e => e.id);
    rs.fortifyIds = fortify.map(e => e.id);
    rs.critical = critical;
    rs.lastScan = Game.time;
    return rs;
}

module.exports = { get, scan, fortifyPolicy, isCritical, needsRepair, isFort };
