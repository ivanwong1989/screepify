// @ts-check
'use strict';

const cache = require('../services/cache');
const roomData = require('../services/roomData');
const { closest } = require('../services/pos');
const state = require('./shared/state');
const matcher = require('../services/matcher');
const { gather } = require('./shared/gather');

/**
 * Hauler executor for 'transfer' missions (supply:* and haul:*), port of v1
 * tasks/exec/transfer for energy.
 *
 * - supply: get energy (storage first if it has any, else nearest pile/container),
 *   deliver to the target, partial loads allowed
 * - haul:   fill from the route's source, deliver to the route's target; routes
 *   with allowPartial deliver as soon as there's cargo
 * - any non-energy cargo goes first to where the logistics request list wants it
 *   (services/matcher: a store asking for it, else storage)
 */

const EMPTY_SOURCE_TIMEOUT = 20;
const FLIP_THRESHOLD = 2;

/** @param {Creep} creep */
function scratch(creep) {
    const s = cache.store('creep.scratch');
    return s[creep.name] || (s[creep.name] = { flips: 0, lastSig: null, waitUntil: 0 });
}

/**
 * Where non-energy cargo goes: the request list decides (no rules of our own,
 * docs/v2/LOGISTICS.md). The fallback order below only applies in rooms
 * without a request list (no storage or not owned).
 * @param {import('../contracts/ctx').RoomCtx} rc
 * @param {ResourceConstant} type
 * @param {string|undefined} missionTargetId
 * @param {Creep} creep
 */
function dumpTarget(rc, type, missionTargetId, creep) {
    const room = creep.room;
    if (rc.requests && room.name === rc.name) {
        const d = matcher.redirect(rc.requests, type, creep.store[type] || 0);
        if (d) return /** @type {any} */ (state.obj(d));
    }
    if (room.storage && room.storage.store.getFreeCapacity(type) > 0) return room.storage;
    if (room.terminal && room.terminal.store.getFreeCapacity(type) > 0) return room.terminal;
    const t = /** @type {any} */ (state.obj(missionTargetId));
    if (t && t.store && [STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_TOWER].indexOf(t.structureType) === -1 &&
        t.store.getFreeCapacity(type) > 0) return t;
    return closest(creep.pos, roomData.byType(room, STRUCTURE_CONTAINER).filter(c => c.store.getFreeCapacity(type) > 0));
}

/**
 * Pick up energy lying right next to the route source without walking (v1 local top-up).
 * @param {Creep} creep
 * @param {any} data
 * @returns {import('../contracts/task').Task|null}
 */
function localTopUp(creep, data) {
    if (!data.allowPartial || !data.sourceId) return null;
    const carried = creep.store.getUsedCapacity(RESOURCE_ENERGY);
    if (carried <= 0 || creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return null;
    const anchor = /** @type {any} */ (state.obj(data.sourceId));
    if (!anchor || !anchor.pos || !creep.pos.inRangeTo(anchor.pos, 1)) return null;
    if (anchor instanceof Resource) {
        if (anchor.resourceType === RESOURCE_ENERGY && anchor.amount > 0) return { a: 'pickup', i: anchor.id };
    } else if (anchor.store && anchor.store[RESOURCE_ENERGY] > 0) {
        return { a: 'withdraw', i: anchor.id, r: RESOURCE_ENERGY };
    }
    const piles = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
        filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 0 && r.pos.inRangeTo(anchor.pos, 1)
    });
    if (piles.length > 0) {
        piles.sort((a, b) => b.amount - a.amount);
        return { a: 'pickup', i: piles[0].id };
    }
    return null;
}

/**
 * @param {Creep} creep
 * @param {import('../contracts/mission').Mission} m
 * @param {import('../contracts/ctx').RoomCtx} rc
 * @param {number} [depth]
 * @returns {import('../contracts/task').Task|null}
 */
function nextTask(creep, m, rc, depth) {
    const d = depth || 0;
    if (d > 2) return null;
    const data = /** @type {any} */ (m.data || {});
    const isSupply = data.mode === 'supply';
    const allowPartial = !!data.allowPartial;
    const room = creep.room;
    const prev = creep.memory.s;
    const sc = scratch(creep);

    // Non-energy cargo goes home first.
    for (const type in creep.store) {
        const rt = /** @type {ResourceConstant} */ (type);
        if (rt === RESOURCE_ENERGY || (creep.store[rt] || 0) <= 0) continue;
        const dump = dumpTarget(rc, rt, m.targetId, creep);
        if (dump) return { a: 'transfer', i: dump.id, r: rt };
    }

    state.update(creep, RESOURCE_ENERGY, { requireFull: !allowPartial, allowPartialWork: isSupply || allowPartial });
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 || creep.memory.s === 'working') {
        sc.flips = 0;
        sc.lastSig = null;
    }

    // A route that just emptied mid-delivery is finished (v1: abort working→gathering).
    if (!isSupply && prev === 'working' && creep.memory.s === 'gathering') return null;

    if (creep.memory.s === 'working') {
        sc.waitUntil = 0;
        const target = /** @type {any} */ (state.obj(m.targetId));
        if (!target) return null;
        if (target.store && target.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return null;
        return { a: 'transfer', i: target.id, r: RESOURCE_ENERGY };
    }

    // Gathering.
    let task = localTopUp(creep, data);
    if (!task) {
        if (isSupply && room.storage && room.storage.store[RESOURCE_ENERGY] > 0) {
            task = gather(creep, rc, { allowedIds: [room.storage.id], allowPartial: true });
        } else if (data.sourceId) {
            task = gather(creep, rc, { allowedIds: [data.sourceId], allowPartial });
        } else {
            task = gather(creep, rc, { preferNearestAvailable: isSupply, allowPartial });
        }
    }

    if (task) {
        sc.waitUntil = 0;
        // Anti ping-pong: with cargo on a partial route, stop changing gather targets after 2 flips.
        if (allowPartial && creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 && state.obj(m.targetId)) {
            const sig = `${task.a}:${task.i || ''}`;
            if (sc.lastSig && sc.lastSig !== sig) sc.flips++;
            sc.lastSig = sig;
            if (sc.flips >= FLIP_THRESHOLD) {
                creep.memory.s = 'working';
                sc.flips = 0;
                sc.lastSig = null;
                return nextTask(creep, m, rc, d + 1);
            }
        }
        return task;
    }

    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        creep.memory.s = 'working';
        return nextTask(creep, m, rc, d + 1);
    }

    // Route source is empty: wait next to it for a while before giving up.
    if (data.sourceId) {
        if (!sc.waitUntil) sc.waitUntil = Game.time + EMPTY_SOURCE_TIMEOUT;
        if (Game.time < sc.waitUntil) {
            const source = /** @type {any} */ (state.obj(data.sourceId));
            if (source && !creep.pos.inRangeTo(source.pos, 1)) return { a: 'move', i: source.id, n: 1 };
            return { a: 'wait', q: Math.min(sc.waitUntil, Game.time + 5) };
        }
        sc.waitUntil = 0;
    }
    return null;
}

module.exports = { type: 'transfer', nextTask: (creep, m, rc) => nextTask(creep, m, rc, 0) };
