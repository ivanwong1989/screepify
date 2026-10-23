// @ts-check
'use strict';

const cache = require('../services/cache');
const roomData = require('../services/roomData');
const { closest } = require('../services/pos');
const laneClaims = require('../services/laneClaims');

/**
 * Logistics missions (port of v1 mission.logistics, energy routes).
 *
 * - supply:<id>          refill spawn / extension / tower / lab (any hauler)
 * - haul:<src>:<dst>:sN  move energy along a route; up to 3 slots per route
 *
 * Route classes and their gating (v1 policy):
 *   drop_mining   piles next to efficient sources → closest inflow sink
 *   scavenge      piles > 100, ruins, tombstones  → closest inflow sink
 *   mining        mining containers (≥ one hauler load) → closest inflow sink
 *   consolidation non-mining containers ≥ 500 (not the controller's) → storage
 *   link_out      links near storage/spawn (not the controller's) → storage
 *
 * Small amounts wait (minAmount) unless they've been waiting maxAgeTicks.
 *
 * Phase 2: terminal energy targets and mineral routes (needs terminal/labs).
 */

const MAX_HAULER_CARRY_PARTS = 25;

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

/**
 * @param {string} type
 * @param {number} cap
 * @returns {{minAmount: number, maxAgeTicks: number, allowPartial: boolean}}
 */
function routePolicy(type, cap) {
    if (type === 'link_out') return { minAmount: 1, maxAgeTicks: 20, allowPartial: true };
    if (type === 'drop_mining') return { minAmount: 1, maxAgeTicks: 15, allowPartial: true };
    if (type === 'scavenge') return { minAmount: clamp(Math.floor(cap * 0.15), 50, 300), maxAgeTicks: 200, allowPartial: true };
    if (type === 'mining') return { minAmount: clamp(Math.floor(cap * 0.35), 100, 800), maxAgeTicks: 450, allowPartial: false };
    if (type === 'consolidation') return { minAmount: clamp(Math.floor(cap * 0.25), 100, 800), maxAgeTicks: 650, allowPartial: false };
    return { minAmount: clamp(Math.floor(cap * 0.25), 50, 800), maxAgeTicks: 650, allowPartial: false };
}

/**
 * @param {string} type
 * @param {any} target
 * @param {boolean} emergency
 */
function priority(type, target, emergency) {
    if (type === 'outflow') {
        if (target.structureType === STRUCTURE_TOWER) return emergency ? 950 : 95;
        if (target.structureType === STRUCTURE_SPAWN || target.structureType === STRUCTURE_EXTENSION) return emergency ? 900 : 90;
        return 50;
    }
    if (type === 'link_out') return 95;
    if (type === 'mining') return 85;
    if (type === 'drop_mining') return 47;
    if (type === 'scavenge') return 45;
    return 10;
}

/**
 * Ticks a route has had resources waiting (heap; pruned every 200 ticks).
 * @param {string} roomName
 */
function ageStore(roomName) {
    const root = cache.store('logistics.routeAge');
    if (!root.rooms) {
        root.rooms = Object.create(null);
        root.lastPrune = Game.time;
    }
    if (Game.time - root.lastPrune >= 200) {
        root.lastPrune = Game.time;
        for (const rn in root.rooms) {
            const rm = root.rooms[rn];
            for (const k in rm) if (Game.time - rm[k] > 2000) delete rm[k];
        }
    }
    return root.rooms[roomName] || (root.rooms[roomName] = Object.create(null));
}

/** True when the link is next to the core lane head. @param {Room} room @param {StructureLink} link */
function laneHeadNear(room, link) {
    const lane = require('../services/laneStore').get(room);
    if (!lane) return false;
    const hx = lane.head % 50;
    const hy = (lane.head - hx) / 50;
    return Math.max(Math.abs(link.pos.x - hx), Math.abs(link.pos.y - hy)) <= 1;
}

/** @param {any} o */
function amountOf(o) {
    if (!o) return 0;
    if (o.store) return o.store[RESOURCE_ENERGY] || 0;
    return o.amount || 0;
}

/**
 * @param {import('../contracts/mission').PlanContext} plan
 * @param {import('../contracts/mission').Mission[]} out
 */
function generate(plan, out) {
    const { rc, intel, state: rs, budget, efficientSources } = plan;
    if (efficientSources.size === 0) return;

    const room = rc.room;
    const emergency = rs.op === 'EMERGENCY';
    const storage = room.storage;
    const spawns = roomData.myByType(room, STRUCTURE_SPAWN);
    if (!storage && spawns.length === 0) return;

    const carryParts = Math.min(Math.max(1, Math.floor((budget || 0) / 100)), MAX_HAULER_CARRY_PARTS);
    const cap = Math.max(50, carryParts * 50);
    const ages = ageStore(room.name);
    /** @type {Map<string, import('../contracts/mission').Mission>} */
    const active = new Map();
    const coveredTargets = new Set();
    // Spawns/extensions/towers on the core lane are the lane hauler's while it lives.
    const laneTargets = laneClaims.of(rc).core;
    if (laneTargets) for (const id of laneTargets) coveredTargets.add(id);

    /**
     * @param {string} routeKey
     * @param {number} amount
     */
    const routeAge = (routeKey, amount) => {
        if (amount <= 0) {
            delete ages[routeKey];
            return 0;
        }
        if (!ages[routeKey]) ages[routeKey] = Game.time;
        return Game.time - ages[routeKey];
    };

    /**
     * @param {string} id
     * @param {any} target
     * @param {string} type
     * @param {string|null} sourceId
     * @param {boolean} allowPartial
     */
    const addHaul = (id, target, type, sourceId, allowPartial) => {
        active.set(id, {
            id, type: 'transfer', home: room.name, room: room.name, archetype: 'hauler',
            demand: { minCreeps: 1, maxCreeps: 1 }, spawn: false,
            targetId: target.id, pos: target.pos,
            data: { sourceId, resourceType: RESOURCE_ENERGY, allowPartial },
            priority: priority(type, target, emergency)
        });
    };

    // 1) Keep routes that creeps are already working on (continuity).
    for (const creep of (rc.census ? rc.census.creeps : [])) {
        const name = creep.memory.m;
        if (!name || name.indexOf('haul:') !== 0) continue;
        const parts = name.split(':');
        if (parts.length < 4) continue;
        const source = /** @type {any} */ (Game.getObjectById(/** @type {any} */ (parts[1])));
        const target = /** @type {any} */ (Game.getObjectById(/** @type {any} */ (parts[2])));
        if (!source || !target) continue;
        let type = 'misc';
        if ([STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_TOWER].indexOf(target.structureType) !== -1) type = 'outflow';
        else if (source instanceof Resource || source instanceof Tombstone || source instanceof Ruin) type = 'scavenge';
        else if (target.structureType === STRUCTURE_STORAGE) {
            type = source.structureType === STRUCTURE_LINK ? 'link_out'
                : (intel.miningContainerIds.has(source.id) ? 'mining' : 'consolidation');
        } else if (target.structureType === STRUCTURE_CONTAINER) {
            type = intel.miningContainerIds.has(source.id) ? 'mining' : 'scavenge';
        }
        addHaul(name, target, type, source.id, routePolicy(type, cap).allowPartial);
        coveredTargets.add(target.id);
    }

    // 2) Refill sinks.
    const supplyLists = [STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_TOWER, STRUCTURE_LAB];
    for (const type of supplyLists) {
        for (const target of roomData.myByType(room, type)) {
            if (coveredTargets.has(target.id)) continue;
            if (target.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) continue;
            const id = `supply:${target.id}`;
            if (!active.has(id)) {
                active.set(id, {
                    id, type: 'transfer', home: room.name, room: room.name, archetype: 'hauler',
                    demand: { minCreeps: 1, maxCreeps: 1 }, spawn: false,
                    targetId: target.id, pos: target.pos,
                    data: { resourceType: RESOURCE_ENERGY, mode: 'supply' },
                    priority: priority('outflow', target, emergency)
                });
            }
            coveredTargets.add(target.id);
        }
    }

    /**
     * Adds slot missions for one route (v1 getHaulSlotsForRoute + addLogisticsMissionsForRoute).
     * @param {any} source
     * @param {any} target
     * @param {string} type
     */
    const addRoute = (source, target, type) => {
        if (target.store && target.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return;
        const routeKey = `haul:${source.id}:${target.id}`;
        const amount = amountOf(source);
        const age = routeAge(routeKey, amount);
        if (amount <= 0) return;
        const policy = routePolicy(type, cap);
        if (amount < policy.minAmount && age < policy.maxAgeTicks) return;

        const dist = source.pos.getRangeTo(target.pos);
        const roundTrip = (dist * 2 + 10) * 2 + 10;
        let slots = clamp(Math.ceil(((amount / cap) * roundTrip) / 100), 1, 3);
        if (!policy.allowPartial) {
            while (slots > 1) {
                const tail = Math.max(0, amount - cap * (slots - 1));
                if (tail >= policy.minAmount || age >= policy.maxAgeTicks) break;
                slots--;
            }
        }

        let remaining = amount;
        for (let i = 0; i < slots; i++) {
            if (active.has(`${routeKey}:s${i}`)) remaining = Math.max(0, remaining - cap);
        }
        for (let i = 0; i < slots; i++) {
            const id = `${routeKey}:s${i}`;
            if (active.has(id)) continue;
            if (remaining <= 0) break;
            if (!policy.allowPartial && remaining < policy.minAmount && age < policy.maxAgeTicks) break;
            addHaul(id, target, type, source.id, policy.allowPartial);
            remaining -= Math.min(cap, remaining);
        }
    };

    // 3) Inflow routes into storage / non-mining containers.
    const containers = roomData.byType(room, STRUCTURE_CONTAINER);
    const miningContainers = containers.filter(c => intel.miningContainerIds.has(c.id));
    const nonMining = containers.filter(c => !intel.miningContainerIds.has(c.id));
    const sinks = [];
    if (storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) sinks.push(storage);
    // With storage, the only other sink is the controller container; other
    // containers are drained into storage below (consolidation), so filling
    // them too would pass energy in and out of the same container
    // (docs/v2/LOGISTICS.md bands).
    for (const c of nonMining) {
        if (storage && c.id !== intel.controllerContainerId) continue;
        if (c.store.getFreeCapacity(RESOURCE_ENERGY) > 0) sinks.push(c);
    }

    if (sinks.length > 0) {
        const nearEfficient = new Set();
        for (const s of intel.sources) {
            if (!efficientSources.has(s.id)) continue;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) nearEfficient.add(`${s.pos.x + dx},${s.pos.y + dy}`);
            }
        }
        const dropped = roomData.dropped(room);
        for (const r of dropped) {
            if (r.resourceType !== RESOURCE_ENERGY || r.amount <= 0) continue;
            if (!nearEfficient.has(`${r.pos.x},${r.pos.y}`)) continue;
            const sink = closest(r.pos, sinks);
            if (sink) addRoute(r, sink, 'drop_mining');
        }
        /** @type {any[]} */
        const scavenge = dropped.filter(r => r.resourceType === RESOURCE_ENERGY && r.amount > 100);
        for (const r of roomData.ruins(room)) if (r.store[RESOURCE_ENERGY] > 0) scavenge.push(r);
        for (const t of roomData.tombstones(room)) if (t.store[RESOURCE_ENERGY] > 0) scavenge.push(t);
        for (const s of scavenge) {
            const sink = closest(s.pos, sinks);
            if (sink) addRoute(s, sink, 'scavenge');
        }
        const laneContainers = laneClaims.of(rc).mining;
        for (const c of miningContainers) {
            if (laneContainers.has(c.id)) continue;
            if ((c.store[RESOURCE_ENERGY] || 0) < carryParts * 50) continue;
            const sink = closest(c.pos, sinks);
            if (sink) addRoute(c, sink, 'mining');
        }
    }

    // 4) Consolidation and link drain into storage.
    if (storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        for (const c of nonMining) {
            if (c.store[RESOURCE_ENERGY] >= 500 && c.id !== intel.controllerContainerId) addRoute(c, storage, 'consolidation');
        }
        const ctrl = room.controller;
        for (const link of roomData.myByType(room, STRUCTURE_LINK)) {
            if (link.store[RESOURCE_ENERGY] <= 0) continue;
            const nearCore = link.pos.inRangeTo(storage.pos, 3) || spawns.some(s => link.pos.inRangeTo(s.pos, 3));
            if (!nearCore) continue;
            if (ctrl && link.pos.inRangeTo(ctrl.pos, 3)) continue;
            // The lane hauler drains the link at its head (v1).
            if (laneTargets && link.pos.inRangeTo(storage.pos, 2) && laneHeadNear(room, link)) continue;
            addRoute(link, storage, 'link_out');
        }
    }

    for (const m of active.values()) out.push(m);
}

module.exports = { type: 'logistics', generate, routePolicy, priority, MAX_HAULER_CARRY_PARTS };
