// @ts-check
'use strict';

const cache = require('../../services/cache');
const roomData = require('../../services/roomData');

/**
 * Room intel and room state (port of v1 overseer.intel).
 *
 * Writes `room.intel` and `room.state` on the RoomCtx every tick. Terrain-only
 * facts (open tiles around sources/controller) are computed once per VM, and
 * container/link positions only when the structure count changes.
 */

/**
 * @typedef {Object} SourceIntel
 * @property {string} id
 * @property {RoomPosition} pos
 * @property {number} energy
 * @property {number} energyCapacity
 * @property {string|null} containerId
 * @property {string|null} linkId
 * @property {number} availableSpaces
 *
 * @typedef {Object} RoomIntel
 * @property {SourceIntel[]} sources
 * @property {StructureController|undefined} controller
 * @property {string|null} controllerContainerId
 * @property {number} availableControllerSpaces
 * @property {number} energyAvailable
 * @property {number} energyCapacityAvailable
 * @property {number} storageEnergy
 * @property {number} storageCapacity
 * @property {string[]} energySourceIds  storage, containers, piles > 50, ruins, tombstones with energy
 * @property {Set<string>} miningContainerIds
 * @property {Creep[]} myCreeps          my creeps physically in the room (any home)
 * @property {Creep[]} hostiles
 * @property {ConstructionSite[]} sites
 *
 * @typedef {'EMERGENCY'|'NORMAL'} OpState
 * @typedef {'UPGRADING'|'STOCKPILING'} EconomyState
 * @typedef {{op: OpState, economy: EconomyState}} RoomState
 */

/** Upgrade start/stop thresholds by RCL when the room has storage (v1 values). */
const ECONOMY_THRESHOLDS = {
    1: { start: 10000, stop: 5000 },
    2: { start: 20000, stop: 10000 },
    3: { start: 30000, stop: 15000 },
    4: { start: 40000, stop: 20000 },
    5: { start: 100000, stop: 80000 },
    6: { start: 200000, stop: 150000 },
    7: { start: 500000, stop: 450000 },
    8: { start: 700000, stop: 500000 }
};
const STORAGE_FILL_UPGRADE_START = 0.90;
const STORAGE_FILL_UPGRADE_STOP = 0.80;

/**
 * Terrain-derived facts, once per VM per room.
 * @param {Room} room
 */
function staticInfo(room) {
    const store = cache.store('intel.static');
    let s = store[room.name];
    if (s) return s;
    const terrain = room.getTerrain();
    /** @type {Record<string, number>} */
    const spaces = {};
    for (const src of roomData.sources(room)) {
        let n = 0;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                if (terrain.get(src.pos.x + dx, src.pos.y + dy) !== TERRAIN_MASK_WALL) n++;
            }
        }
        spaces[src.id] = n;
    }
    let controllerSpaces = 0;
    if (room.controller) {
        const c = room.controller.pos;
        for (let dx = -3; dx <= 3; dx++) {
            for (let dy = -3; dy <= 3; dy++) {
                if (dx === 0 && dy === 0) continue;
                const x = c.x + dx;
                const y = c.y + dy;
                if (x < 0 || x > 49 || y < 0 || y > 49) continue;
                if (terrain.get(x, y) !== TERRAIN_MASK_WALL) controllerSpaces++;
            }
        }
    }
    s = store[room.name] = { spaces, controllerSpaces };
    return s;
}

/**
 * Container/link placement, recomputed when the structure count changes.
 * @param {Room} room
 */
function placementInfo(room) {
    const store = cache.store('intel.placement');
    const structs = roomData.structures(room);
    const sig = structs.length;
    const cached = store[room.name];
    if (cached && cached.sig === sig) return cached;

    /** @type {Record<string, string>} */
    const containerAt = {};
    for (const c of roomData.byType(room, STRUCTURE_CONTAINER)) {
        const k = `${c.pos.x},${c.pos.y}`;
        if (containerAt[k] === undefined) containerAt[k] = c.id;
    }
    /** @type {Record<string, string>} */
    const linkAt = {};
    for (const l of roomData.byType(room, STRUCTURE_LINK)) {
        const k = `${l.pos.x},${l.pos.y}`;
        if (linkAt[k] === undefined) linkAt[k] = l.id;
    }
    /**
     * @param {RoomPosition} p
     * @param {number} r
     * @param {Record<string, string>} map
     */
    const findNear = (p, r, map) => {
        for (let dx = -r; dx <= r; dx++) {
            for (let dy = -r; dy <= r; dy++) {
                if (dx === 0 && dy === 0) continue;
                const id = map[`${p.x + dx},${p.y + dy}`];
                if (id) return id;
            }
        }
        return null;
    };
    /** @type {Record<string, string|null>} */
    const sourceContainer = {};
    /** @type {Record<string, string|null>} */
    const sourceLink = {};
    for (const src of roomData.sources(room)) {
        sourceContainer[src.id] = findNear(src.pos, 1, containerAt);
        sourceLink[src.id] = findNear(src.pos, 2, linkAt);
    }
    const controllerContainerId = room.controller ? findNear(room.controller.pos, 3, containerAt) : null;
    const out = { sig, sourceContainer, sourceLink, controllerContainerId };
    store[room.name] = out;
    return out;
}

/**
 * @param {Room} room
 * @returns {RoomIntel}
 */
function gather(room) {
    const st = staticInfo(room);
    const pl = placementInfo(room);
    const storage = room.storage;

    const sources = roomData.sources(room).map(s => ({
        id: s.id,
        pos: s.pos,
        energy: s.energy,
        energyCapacity: s.energyCapacity,
        containerId: pl.sourceContainer[s.id] || null,
        linkId: pl.sourceLink[s.id] || null,
        availableSpaces: st.spaces[s.id] || 0
    }));
    const miningContainerIds = new Set();
    for (const s of sources) if (s.containerId) miningContainerIds.add(s.containerId);

    const energySourceIds = [];
    if (storage && storage.store[RESOURCE_ENERGY] > 0) energySourceIds.push(storage.id);
    for (const c of roomData.byType(room, STRUCTURE_CONTAINER)) {
        if (c.store[RESOURCE_ENERGY] > 0) energySourceIds.push(c.id);
    }
    for (const r of roomData.dropped(room)) {
        if (r.resourceType === RESOURCE_ENERGY && r.amount > 50) energySourceIds.push(r.id);
    }
    for (const r of roomData.ruins(room)) {
        if (r.store[RESOURCE_ENERGY] > 0) energySourceIds.push(r.id);
    }
    for (const t of roomData.tombstones(room)) {
        if (t.store[RESOURCE_ENERGY] > 0) energySourceIds.push(t.id);
    }

    return {
        sources,
        controller: room.controller,
        controllerContainerId: pl.controllerContainerId,
        availableControllerSpaces: st.controllerSpaces,
        energyAvailable: room.energyAvailable,
        energyCapacityAvailable: room.energyCapacityAvailable,
        storageEnergy: storage ? storage.store[RESOURCE_ENERGY] : 0,
        storageCapacity: storage ? storage.store.getCapacity(RESOURCE_ENERGY) : 0,
        energySourceIds,
        miningContainerIds,
        myCreeps: roomData.myCreeps(room),
        hostiles: roomData.hostiles(room),
        sites: roomData.sites(room)
    };
}

/**
 * @param {Room} room
 * @param {RoomIntel} intel
 * @returns {OpState}
 */
function opState(room, intel) {
    const creeps = intel.myCreeps;
    if (creeps.length === 0) return 'EMERGENCY';
    if (intel.energyAvailable < 300 && creeps.length < 2) return 'EMERGENCY';
    if (intel.sources.length > 0 && !creeps.some(c => c.memory.a === 'miner')) return 'EMERGENCY';
    return 'NORMAL';
}

/**
 * STOCKPILING ⇄ UPGRADING with hysteresis (v1 rules). Persisted in Memory.rooms[n].eco.
 * @param {Room} room
 * @param {RoomIntel} intel
 * @returns {EconomyState}
 */
function economyState(room, intel) {
    const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    const m = /** @type {any} */ (mem);
    const override = m.ecoOverride ? String(m.ecoOverride).trim().toUpperCase() : '';
    if (override === 'UPGRADING' || override === 'STOCKPILING') return override;

    let current = m.eco || 'STOCKPILING';
    let logisticsEnergy = 0;
    let logisticsCapacity = 0;
    for (const c of roomData.byType(room, STRUCTURE_CONTAINER)) {
        if (intel.miningContainerIds.has(c.id)) continue;
        logisticsEnergy += c.store[RESOURCE_ENERGY];
        logisticsCapacity += c.store.getCapacity(RESOURCE_ENERGY);
    }
    const totalStored = logisticsEnergy + intel.storageEnergy;
    const totalCapacity = logisticsCapacity + intel.storageCapacity;

    if (totalCapacity < 500) return 'UPGRADING';

    if (room.storage) {
        const rcl = (room.controller && room.controller.level) || 1;
        const th = ECONOMY_THRESHOLDS[rcl] || ECONOMY_THRESHOLDS[5];
        const fill = room.storage.store.getUsedCapacity() / (room.storage.store.getCapacity() || 1);
        if (current === 'STOCKPILING' && (totalStored >= th.start || fill >= STORAGE_FILL_UPGRADE_START)) {
            current = 'UPGRADING';
        } else if (current === 'UPGRADING' && totalStored <= th.stop && fill <= STORAGE_FILL_UPGRADE_STOP) {
            current = 'STOCKPILING';
        }
    } else {
        current = 'UPGRADING';
    }
    m.eco = current;
    return current;
}

/** @type {import('../../contracts/process').Process} */
module.exports = {
    id: 'sense.intel',
    phase: 'SENSE',
    scope: 'room',
    kinds: ['owned', 'bootstrap'],
    tier: 'critical',
    priority: 10,
    init(ctx) {
        roomData.setAllies(ctx.config.allies);
    },
    run(ctx, rc) {
        roomData.setAllies(ctx.config.allies);
        const intel = gather(rc.room);
        rc.intel = intel;
        rc.state = { op: opState(rc.room, intel), economy: economyState(rc.room, intel) };
    },
    gather,
    opState,
    economyState
};
