// @ts-check
'use strict';

const cache = require('../services/cache');
const roomData = require('../services/roomData');
const { closest, pack } = require('../services/pos');

/**
 * Parking (port of v1 mission.decongest + exec/decongest).
 *
 * Flags named "Parking*" define parking rings (radius 1–3). Idle creeps with
 * nothing else to do park there instead of clogging roads. Lowest priority.
 */

/**
 * @param {Room} room
 * @param {Flag[]} flags
 */
function slots(room, flags) {
    const terrain = room.getTerrain();
    const blocked = new Set();
    for (const s of roomData.structures(room)) {
        if (OBSTACLE_OBJECT_TYPES.indexOf(/** @type {any} */ (s.structureType)) === -1) continue;
        if (s.structureType === STRUCTURE_RAMPART && (/** @type {any} */ (s).my || /** @type {any} */ (s).isPublic)) continue;
        blocked.add(s.pos.y * 50 + s.pos.x);
    }
    for (const site of roomData.sites(room)) {
        if (OBSTACLE_OBJECT_TYPES.indexOf(/** @type {any} */ (site.structureType)) === -1) continue;
        if (site.structureType === STRUCTURE_RAMPART) continue;
        blocked.add(site.pos.y * 50 + site.pos.x);
    }
    /** @type {Map<number, string>} */
    const out = new Map();
    for (const flag of flags) {
        for (let r = 1; r <= 3; r++) {
            for (let dx = -r; dx <= r; dx++) {
                for (let dy = -r; dy <= r; dy++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                    const x = flag.pos.x + dx;
                    const y = flag.pos.y + dy;
                    if (x < 1 || x > 48 || y < 1 || y > 48) continue;
                    if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
                    const idx = y * 50 + x;
                    if (blocked.has(idx) || out.has(idx)) continue;
                    out.set(idx, pack({ x, y, roomName: room.name }));
                }
            }
        }
    }
    return Array.from(out.values());
}

/**
 * @param {import('../contracts/mission').PlanContext} plan
 * @param {import('../contracts/mission').Mission[]} out
 */
function generate(plan, out) {
    const { rc } = plan;
    const flags = roomData.flags(rc.room).filter(f => f.name.indexOf('Parking') === 0);
    if (flags.length === 0) return;
    const slotList = slots(rc.room, flags);
    if (slotList.length === 0) return;
    out.push({
        id: 'decongest:parking', type: 'decongest', home: rc.name, room: rc.name,
        demand: { minCreeps: 0, maxCreeps: slotList.length }, spawn: false,
        data: { slots: slotList },
        priority: -200
    });
}

/** @type {import('../contracts/mission').MissionType['nextTask']} */
function nextTask(creep, m, rc) {
    // Drop off cargo first.
    for (const type in creep.store) {
        const rt = /** @type {ResourceConstant} */ (type);
        if ((creep.store[rt] || 0) <= 0) continue;
        const room = creep.room;
        const dump = (room.storage && room.storage.store.getFreeCapacity(rt) > 0)
            ? room.storage
            : closest(creep.pos, roomData.byType(room, STRUCTURE_CONTAINER).filter(c => c.store.getFreeCapacity(rt) > 0));
        if (dump) return { a: 'transfer', i: dump.id, r: rt };
    }
    const slotList = /** @type {any} */ (m.data).slots || [];
    const parked = cache.perTick(`parked:${rc.name}:${m.id}`, () =>
        (rc.census ? rc.census.active : []).filter(c => c.memory.m === m.id).sort((a, b) => (a.name < b.name ? -1 : 1)));
    const index = parked.findIndex(c => c.id === creep.id);
    if (index === -1 || index >= slotList.length) return null;
    const slot = slotList[index];
    if (pack(creep.pos) === slot) return { a: 'wait', q: Game.time + 5 };
    return { a: 'move', p: slot, n: 0 };
}

module.exports = { type: 'decongest', generate, nextTask };
