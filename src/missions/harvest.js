// @ts-check
'use strict';

const cache = require('../services/cache');
const roomData = require('../services/roomData');
const body = require('../services/body');
const state = require('./shared/state');
const stations = require('../services/miningStations');
const readiness = require('../services/miningReadiness');
const { unpack } = require('../services/pos');

/**
 * Harvest missions, one per source (port of v1 mission.harvest + exec/harvest).
 *
 * Modes:
 * - static:      container (and maybe link) at the source; one elected owner sits on the container
 * - static_drop: haulers exist but no container yet; miners drop energy for pickup
 * - mobile:      no haulers yet; miners carry energy to spawn/extensions/towers/storage,
 *                falling back to upgrading
 */

const TRAVEL_TTL = 200;
const TARGET_WORK = 7;

/**
 * Best tile next to a source to measure travel distance to (v1 anchor).
 * @param {Room} room
 * @param {{id: string, pos: RoomPosition, containerId: string|null}} source
 */
function anchorPos(room, source) {
    if (source.containerId) {
        const c = state.obj(source.containerId);
        if (c) return /** @type {any} */ (c).pos;
    }
    const terrain = room.getTerrain();
    let best = null;
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const x = source.pos.x + dx;
            const y = source.pos.y + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
            const blocked = room.lookForAt(LOOK_STRUCTURES, x, y).some(s =>
                s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_CONTAINER &&
                !(s.structureType === STRUCTURE_RAMPART && /** @type {any} */ (s).my));
            if (blocked) continue;
            const pos = new RoomPosition(x, y, room.name);
            if (!best) best = pos;
            if (terrain.get(x, y) !== TERRAIN_MASK_SWAMP) return pos;
        }
    }
    return best;
}

/**
 * Path length from the nearest spawn to the source, cached for TRAVEL_TTL ticks.
 * @param {Room} room
 * @param {StructureSpawn[]} spawns
 * @param {{id: string, pos: RoomPosition, containerId: string|null}} source
 */
function sourceDistance(room, spawns, source) {
    const store = cache.store('harvest.travel', { ttl: TRAVEL_TTL });
    const key = `${room.name}:${source.id}`;
    if (store[key] !== undefined) return store[key];
    const anchor = anchorPos(room, source);
    let best = Infinity;
    if (anchor) {
        for (const spawn of spawns) {
            const ret = PathFinder.search(spawn.pos, { pos: anchor, range: 0 }, { maxOps: 2000, plainCost: 2, swampCost: 10 });
            if (!ret.incomplete && ret.path.length < best) best = ret.path.length;
        }
    }
    store[key] = Number.isFinite(best) ? best : 0;
    return store[key];
}

/**
 * @param {number} pathLen
 * @param {number} bodyLen
 * @param {number} moveParts
 */
function travelTicks(pathLen, bodyLen, moveParts) {
    if (!pathLen || pathLen <= 0) return 0;
    if (!bodyLen) return pathLen;
    if (!moveParts) return pathLen * bodyLen;
    return pathLen * Math.max(1, Math.ceil(bodyLen / (2 * moveParts)));
}

/**
 * @param {import('../contracts/mission').PlanContext} plan
 * @param {import('../contracts/mission').Mission[]} out
 */
function generate(plan, out) {
    const { rc, intel, state: rs, budget, efficientSources } = plan;
    const room = rc.room;
    const isEmergency = rs.op === 'EMERGENCY';
    const spawns = roomData.myByType(room, STRUCTURE_SPAWN);
    const extensions = roomData.myByType(room, STRUCTURE_EXTENSION);
    const towers = roomData.myByType(room, STRUCTURE_TOWER);
    const storage = room.storage;

    for (const source of intel.sources) {
        const efficient = efficientSources.has(source.id);
        const canStatic = efficient && readiness.ready(rc, source);
        const mode = canStatic ? (source.containerId ? 'static' : 'static_drop') : 'mobile';

        const containerId = mode === 'static' ? source.containerId : null;
        let dropoffIds = [];
        let fallback = 'none';
        if (mode === 'static') {
            if (source.linkId) dropoffIds.push(source.linkId);
            if (containerId) dropoffIds.push(containerId);
        } else if (mode === 'mobile') {
            for (const s of spawns) if (s.store.getFreeCapacity(RESOURCE_ENERGY) > 0) dropoffIds.push(s.id);
            for (const e of extensions) if (e.store.getFreeCapacity(RESOURCE_ENERGY) > 0) dropoffIds.push(e.id);
            for (const t of towers) if (t.store.getFreeCapacity(RESOURCE_ENERGY) >= 50) dropoffIds.push(t.id);
            if (storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) dropoffIds.push(storage.id);
            fallback = 'upgrade';
        }

        const bodyOpts = { mode: mode === 'mobile' ? 'mobile' : 'static' };
        const stats = body.stats('miner', budget, bodyOpts);
        const dist = sourceDistance(room, spawns, source);
        const lead = travelTicks(dist, stats.body.length, stats.move);
        const maxCount = Math.max(1, stations.workingTiles(room, source.pos).length);

        if (mode === 'static' && dropoffIds.length === 0) continue; // invalid contract (v1 guard)

        const slots = [];
        for (let i = 0; i < maxCount; i++) slots.push(`harvest:${room.name}:${source.id}:${i}`);

        out.push({
            id: `harvest:${source.id}`,
            type: 'harvest',
            home: room.name,
            room: room.name,
            archetype: 'miner',
            demand: { work: TARGET_WORK, minCreeps: 1, maxCreeps: maxCount },
            spawn: 'slots',
            slots,
            leadTicks: lead,
            bodyOpts,
            pos: source.pos,
            targetId: source.id,
            data: { sourceId: source.id, mode, dropoffIds, fallback, containerId, overflowPolicy: 'drop' },
            priority: isEmergency ? 1000 : 100
        });
    }
}

/**
 * @param {Creep} creep
 * @param {string[]} ids
 */
function firstDropoff(creep, ids) {
    for (const id of ids) {
        const t = /** @type {any} */ (state.obj(id));
        if (t && t.store && t.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return t;
    }
    return null;
}

/**
 * @param {Creep} creep
 * @param {any} data
 * @returns {import('../contracts/task').Task|null}
 */
function deliverOrFallback(creep, data) {
    const t = firstDropoff(creep, data.dropoffIds);
    if (t) return { a: 'transfer', i: t.id, r: RESOURCE_ENERGY };
    const ctrl = creep.room.controller;
    if (data.fallback === 'upgrade' && ctrl && ctrl.my) return { a: 'upgrade', i: ctrl.id };
    return null;
}

/** @type {import('../contracts/mission').MissionType['nextTask']} */
function nextTask(creep, mission) {
    const data = /** @type {any} */ (mission.data);
    const source = /** @type {Source|null} */ (state.obj(data.sourceId));
    if (!source) return null;
    const sourceId = source.id;

    if (data.mode === 'static') {
        const container = /** @type {StructureContainer|null} */ (state.obj(data.containerId));
        if (!container) return null;
        const station = stations.assignment(creep);
        if (!station || !station.target) return { a: 'wait', q: Game.time + 1 };
        const target = unpack(station.target);
        if (!creep.pos.isEqualTo(target)) return { a: 'move', p: station.target, n: 0 };
        if (station.reason === 'waiting') return { a: 'wait', q: Game.time + 1 };
        if (station.reason === 'container') {
            state.update(creep, RESOURCE_ENERGY, { allowPartialWork: true });
            if (creep.memory.s === 'working' || creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
                return deliverOrFallback(creep, data) || { a: 'harvest', i: sourceId };
            }
            return { a: 'harvest', i: sourceId };
        }

        // Overflow miners use a distinct exact tile, never the container.
        state.update(creep, RESOURCE_ENERGY, { allowPartialWork: true });
        if (creep.memory.s === 'working' || creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
            if (creep.pos.inRangeTo(container.pos, 1) && container.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                return { a: 'transfer', i: container.id, r: RESOURCE_ENERGY };
            }
            if (data.overflowPolicy === 'drop') return { a: 'drop', r: RESOURCE_ENERGY };
            const d = deliverOrFallback(creep, data);
            if (d) return d;
        }
        return { a: 'harvest', i: sourceId };
    }

    if (data.mode === 'static_drop') {
        if (!creep.pos.inRangeTo(source.pos, 1)) return { a: 'move', i: sourceId, n: 1 };
        state.update(creep, RESOURCE_ENERGY, { allowPartialWork: true });
        if (creep.memory.s === 'working' || creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
            const t = firstDropoff(creep, data.dropoffIds);
            if (t) return { a: 'transfer', i: t.id, r: RESOURCE_ENERGY };
            if (data.overflowPolicy === 'drop') return { a: 'drop', r: RESOURCE_ENERGY };
        }
        return { a: 'harvest', i: sourceId };
    }

    // mobile
    state.update(creep, RESOURCE_ENERGY, { allowPartialWork: true });
    if (creep.memory.s !== 'working') return { a: 'harvest', i: sourceId };
    return deliverOrFallback(creep, data) || { a: 'move', i: sourceId, n: 1 };
}

module.exports = { type: 'harvest', generate, nextTask, travelTicks };
