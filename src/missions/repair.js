// @ts-check
'use strict';

const cache = require('../services/cache');
const roomData = require('../services/roomData');
const scanner = require('../services/repairScan');
const state = require('./shared/state');
const { gather } = require('./shared/gather');
const { vacate } = require('./shared/vacate');

/**
 * Repair and fortify (port of v1 mission.repair + exec/repair).
 *
 * repair:<id>   roads/containers, then other structures, then critical walls.
 *               Worker count from the room's decay rate (+8 WORK if something is
 *               critical, +6 under attack), 4 WORK per worker, max 20 WORK.
 *
 * Raising walls/ramparts toward the RCL target is missions/fortify.js.
 */

const BASELINE_TTL = 1000;
const SAFETY = 1.2;
const SWAMP_RATIO = 5;
const WALL_RATIO = 150;

/**
 * WORK parts needed to keep up with road + container decay (cached 1000 ticks).
 * @param {Room} room
 */
function baselineWork(room) {
    const store = cache.store('repair.baseline');
    const c = store[room.name];
    if (c && c.expires > Game.time) return c.work;
    const terrain = room.getTerrain();
    let decay = 0;
    for (const s of roomData.structures(room)) {
        if (s.structureType === STRUCTURE_CONTAINER) {
            decay += CONTAINER_DECAY / CONTAINER_DECAY_TIME_OWNED;
        } else if (s.structureType === STRUCTURE_ROAD) {
            const mask = terrain.get(s.pos.x, s.pos.y);
            const ratio = (mask & TERRAIN_MASK_WALL) ? WALL_RATIO : (mask & TERRAIN_MASK_SWAMP) ? SWAMP_RATIO : 1;
            decay += (ROAD_DECAY_AMOUNT * ratio) / ROAD_DECAY_TIME;
        }
    }
    const work = (decay / REPAIR_POWER) * SAFETY;
    store[room.name] = { work, expires: Game.time + BASELINE_TTL };
    return work;
}

/**
 * @param {import('../contracts/mission').PlanContext} plan
 * @param {import('../contracts/mission').Mission[]} out
 */
function generate(plan, out) {
    const { rc, intel, state: rs, census } = plan;
    if (rs.op === 'EMERGENCY') return;
    const room = rc.room;
    const scan = scanner.get(room.name);
    const hostiles = intel.hostiles.length > 0;

    // Re-validate scanner ids against live objects (the scan can be 7 ticks old).
    const repairTargets = scan.repairIds
        .map(id => /** @type {any} */ (Game.getObjectById(/** @type {any} */ (id))))
        .filter(s => s && (scanner.needsRepair(s) || scanner.isCritical(s)));
    const critical = repairTargets.some(s => scanner.isCritical(s));

    const sourceIds = intel.energySourceIds;

    if (repairTargets.length > 0) {
        const workTarget = Math.min(20, baselineWork(room) + (critical ? 8 : 0) + (hostiles ? 6 : 0));
        const desired = Math.max(1, Math.ceil(workTarget / 4));
        /** @param {any} s */
        const group = (s) => (s.structureType === STRUCTURE_ROAD || s.structureType === STRUCTURE_CONTAINER) ? 0 : scanner.isFort(s) ? 2 : 1;
        const sorted = repairTargets.slice().sort((a, b) =>
            (group(a) - group(b)) || ((a.hits / a.hitsMax) - (b.hits / b.hitsMax)));
        // Keep targets someone is already repairing (less thrash), then fill up.
        const sticky = sorted.filter(s => census(`repair:${s.id}`).count > 0).slice(0, desired);
        const stickyIds = new Set(sticky.map(s => s.id));
        const count = Math.min(sorted.length, Math.max(desired, sticky.length));
        const selected = sticky.concat(sorted.filter(s => !stickyIds.has(s.id)).slice(0, count - sticky.length));
        for (const t of selected) {
            out.push({
                id: `repair:${t.id}`, type: 'repair', home: rc.name, room: rc.name, archetype: 'worker',
                demand: { work: 1, minCreeps: 1, maxCreeps: 1 }, spawn: 'pool',
                targetId: t.id, pos: t.pos,
                data: { sourceIds, allowPartial: true },
                priority: scanner.isCritical(t) ? 85 : 65
            });
        }
    }
}

/** @type {import('../contracts/mission').MissionType['nextTask']} */
function nextTask(creep, m, rc) {
    state.update(creep);
    const data = /** @type {any} */ (m.data || {});
    if (creep.memory.s === 'working') {
        const target = /** @type {any} */ (state.obj(m.targetId));
        if (!target || target.hits >= target.hitsMax) return null;
        return vacate(creep, 'repair', target, 3) || { a: 'repair', i: target.id };
    }
    return gather(creep, rc, { allowedIds: data.sourceIds || null, allowPartial: !!data.allowPartial });
}

module.exports = { type: 'repair', generate, nextTask };
