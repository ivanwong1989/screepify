// @ts-check
'use strict';

const roomData = require('../../services/roomData');
const { closest } = require('../../services/pos');
const { obj } = require('./state');

/**
 * Energy gathering (port of v1 tasks/exec/gather). Picks where a creep should
 * get energy from and reserves that amount so other creeps pick elsewhere.
 *
 * Order (v1): allowed ids if given → else dropped piles > 50 → storage /
 * containers / links with ≥ 50 unreserved → harvest the closest active source
 * if the creep has WORK.
 */

/**
 * @param {any} target
 * @returns {number}
 */
function energyOf(target) {
    if (!target) return 0;
    if (target instanceof Resource) return target.resourceType === RESOURCE_ENERGY ? target.amount : 0;
    return target.store ? (target.store[RESOURCE_ENERGY] || 0) : 0;
}

/**
 * @param {Record<string, number>} reserved
 * @param {Creep} creep
 * @param {any} target
 * @returns {import('../../contracts/task').Task}
 */
function take(reserved, creep, target) {
    reserved[target.id] = (reserved[target.id] || 0) + creep.store.getFreeCapacity();
    if (target instanceof Resource) return { a: 'pickup', i: target.id };
    return { a: 'withdraw', i: target.id, r: RESOURCE_ENERGY };
}

/**
 * @param {Creep} creep
 * @param {import('../../contracts/ctx').RoomCtx} rc
 * @param {{allowedIds?: string[]|null, excludeIds?: string[]|null, allowPartial?: boolean,
 *          preferNearestAvailable?: boolean}} [options]
 * @returns {import('../../contracts/task').Task|null}
 */
function gather(creep, rc, options) {
    const o = options || {};
    const mem = creep.memory;
    const carried = creep.store[RESOURCE_ENERGY] || 0;

    // Sticky delivery: already delivering with cargo → don't gather more.
    if (mem.s === 'working' && carried > 0) return null;
    // Partial routes commit to delivery once there is any energy.
    if (o.allowPartial && carried > 0) {
        mem.s = 'working';
        return null;
    }

    const reserved = rc.census ? rc.census.reserved : {};
    const room = creep.room;
    const excludeIds = o.excludeIds || [];
    const allowedIds = o.allowedIds || null;

    if (allowedIds && allowedIds.length > 0) {
        const valid = [];
        for (const id of allowedIds) {
            if (excludeIds.indexOf(id) !== -1) continue;
            const t = obj(id);
            if (!t) continue;
            if (energyOf(t) - (reserved[id] || 0) > 0) valid.push(t);
        }
        const target = closest(creep.pos, valid);
        if (target) return take(reserved, creep, target);
        if (carried > 0) mem.s = 'working';
        return null;
    }

    const piles = roomData.dropped(room).filter(r =>
        r.resourceType === RESOURCE_ENERGY && r.amount > 50 && excludeIds.indexOf(r.id) === -1 &&
        r.amount - (reserved[r.id] || 0) >= 50);
    const stores = []
        .concat(roomData.byType(room, STRUCTURE_CONTAINER), roomData.byType(room, STRUCTURE_STORAGE),
            roomData.byType(room, STRUCTURE_LINK))
        .filter(s => excludeIds.indexOf(s.id) === -1 &&
            (s.store[RESOURCE_ENERGY] || 0) - (reserved[s.id] || 0) >= 50);

    if (o.preferNearestAvailable) {
        const target = closest(creep.pos, /** @type {any[]} */ (piles).concat(stores));
        if (target) return take(reserved, creep, target);
    } else {
        const pile = closest(creep.pos, piles);
        if (pile) return take(reserved, creep, pile);
        const store = closest(creep.pos, stores);
        if (store) return take(reserved, creep, store);
    }

    if (creep.getActiveBodyparts(WORK) > 0) {
        const source = closest(creep.pos, roomData.activeSources(room));
        if (source) return { a: 'harvest', i: source.id };
    }
    return null;
}

module.exports = { gather, energyOf };
