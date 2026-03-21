const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const overseerOpportunisticRepair = require('managers_overseer_intel_overseer.opportunistic.repair');
const heap = require('utils_heap');

const REPAIR_MIN_RATIO = 0.9;
const WORKER_SET_COST = 200;
const MIN_REPAIR_BACKLOG_TICKS = 120;
const MIN_REPAIR_BACKLOG_HITS_FLOOR = 25000;
const REPAIR_QUEUE_HEAP_STORE = 'missionRepairQueue';

const REPAIR_WORKER_TUNING = Object.freeze({
    desiredWork: 12,
    minCount: 1,
    maxCount: 1,
    maxWorkParts: 12,
    maxCarryParts: 12,
    maxMoveParts: 12
});

function cleanupAssigned(mission) {
    if (!mission.assigned) mission.assigned = { primary: [], support: [] };
    if (!Array.isArray(mission.assigned.primary)) mission.assigned.primary = [];
    mission.assigned.primary = mission.assigned.primary.filter(name => !!Game.creeps[name]);
}

function isFortifyTarget(structure) {
    if (!structure) return false;
    return structure.structureType === STRUCTURE_WALL || structure.structureType === STRUCTURE_RAMPART;
}

function getRepairThreshold(structure) {
    if (!structure || !structure.hitsMax) return 0;
    return Math.floor(structure.hitsMax * REPAIR_MIN_RATIO);
}

function getMaxWorkPartsForRoom(room) {
    if (!room) return 1;
    const capacity = Number.isFinite(room.energyCapacityAvailable) ? room.energyCapacityAvailable : 0;
    if (capacity <= 0) return 1;
    return Math.max(1, Math.min(REPAIR_WORKER_TUNING.maxWorkParts, Math.floor(capacity / WORKER_SET_COST)));
}

function getMinRepairBacklogHits(room) {
    const workParts = getMaxWorkPartsForRoom(room);
    const projected = workParts * REPAIR_POWER * MIN_REPAIR_BACKLOG_TICKS;
    return Math.max(MIN_REPAIR_BACKLOG_HITS_FLOOR, projected);
}

function getRepairQueueStore() {
    return heap.getStore(REPAIR_QUEUE_HEAP_STORE, { ttl: null });
}

function getRepairQueueKey(roomName) {
    return `repair:${roomName || ''}`;
}

function writeRepairQueue(roomName, ids) {
    if (!roomName) return;
    const store = getRepairQueueStore();
    store[getRepairQueueKey(roomName)] = {
        time: Game.time,
        ids: Array.isArray(ids) ? ids.slice() : []
    };
}

function readRepairQueue(roomName) {
    if (!roomName) return [];
    const store = getRepairQueueStore();
    const entry = store[getRepairQueueKey(roomName)];
    return entry && Array.isArray(entry.ids) ? entry.ids : [];
}

function getRepairBacklogSummary(room, scan, structureById) {
    const repairIds = scan && Array.isArray(scan.repairIds) ? scan.repairIds : [];
    const entries = [];
    let totalDeficitHits = 0;

    for (let i = 0; i < repairIds.length; i++) {
        const id = repairIds[i];
        const structure = (structureById && structureById[id]) || Game.getObjectById(id);
        if (!structure) continue;
        if (isFortifyTarget(structure)) continue;
        const targetHits = getRepairThreshold(structure);
        const deficitHits = targetHits - structure.hits;
        if (deficitHits <= 0) continue;

        totalDeficitHits += deficitHits;
        const ratio = targetHits > 0 ? (structure.hits / targetHits) : 1;
        entries.push({ id, ratio, deficitHits });
    }

    entries.sort((a, b) => {
        if (a.ratio !== b.ratio) return a.ratio - b.ratio;
        if (a.deficitHits !== b.deficitHits) return b.deficitHits - a.deficitHits;
        return a.id < b.id ? -1 : 1;
    });
    const orderedIds = entries.map(e => e.id);
    const best = orderedIds.length > 0 ? { id: orderedIds[0], deficitHits: entries[0].deficitHits } : null;

    const minBacklogHits = getMinRepairBacklogHits(room);
    const critical = !!(scan && scan.critical);
    const gatePassed = critical || totalDeficitHits >= minBacklogHits;
    return { best, orderedIds, totalDeficitHits, minBacklogHits, critical, gatePassed };
}

function getMiningContainerIdSet(intel) {
    const ids = new Set();
    const sources = intel && Array.isArray(intel.sources) ? intel.sources : [];
    for (let i = 0; i < sources.length; i++) {
        const id = sources[i] && sources[i].containerId ? sources[i].containerId : null;
        if (id) ids.add(id);
    }
    return ids;
}

function getRoomCache(room) {
    if (!room || typeof global.getRoomCache !== 'function') return null;
    return global.getRoomCache(room);
}

function getNonMiningContainerIds(room, intel, roomCache) {
    if (!room) return [];
    const miningContainerIds = getMiningContainerIdSet(intel);
    const containers = (intel && intel.structures && intel.structures[STRUCTURE_CONTAINER])
        ? intel.structures[STRUCTURE_CONTAINER]
        : (roomCache && roomCache.structuresByType && roomCache.structuresByType[STRUCTURE_CONTAINER])
            ? roomCache.structuresByType[STRUCTURE_CONTAINER]
            : room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER });

    const ids = [];
    for (let i = 0; i < containers.length; i++) {
        const c = containers[i];
        if (!c || !c.id || miningContainerIds.has(c.id)) continue;
        ids.push(c.id);
    }
    return ids;
}

function buildStructureByIdIndex(intel, roomCache) {
    const byId = Object.create(null);

    if (intel && intel.structures) {
        const byType = intel.structures;
        const keys = Object.keys(byType);
        for (let i = 0; i < keys.length; i++) {
            const list = byType[keys[i]];
            if (!Array.isArray(list)) continue;
            for (let j = 0; j < list.length; j++) {
                const s = list[j];
                if (s && s.id) byId[s.id] = s;
            }
        }
        return byId;
    }

    const structures = roomCache && Array.isArray(roomCache.structures) ? roomCache.structures : [];
    for (let i = 0; i < structures.length; i++) {
        const s = structures[i];
        if (s && s.id) byId[s.id] = s;
    }
    return byId;
}

function getRepairRoomMemo(room, intel, roomCache) {
    if (!room) {
        return {
            sourceIds: [],
            nonMiningContainerIds: [],
            structureById: Object.create(null)
        };
    }

    if (roomCache && roomCache._repairMissionMemo && roomCache._repairMissionMemo.time === Game.time) {
        return roomCache._repairMissionMemo;
    }

    const allEnergySources = (intel && Array.isArray(intel.allEnergySources)) ? intel.allEnergySources : [];
    const sourceIds = [];
    for (let i = 0; i < allEnergySources.length; i++) {
        const source = allEnergySources[i];
        if (source && source.id) sourceIds.push(source.id);
    }

    const memo = {
        time: Game.time,
        sourceIds,
        nonMiningContainerIds: getNonMiningContainerIds(room, intel, roomCache),
        structureById: buildStructureByIdIndex(intel, roomCache)
    };

    if (roomCache) roomCache._repairMissionMemo = memo;
    return memo;
}

function getTargetStructure(mission, runtimeCtx) {
    const roomName = mission.targetRoom || mission.sponsorRoom;
    const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
    if (!room) return { room: null, structure: null, memo: null };

    const intel = runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null;
    const roomCache = getRoomCache(room);
    const memo = getRepairRoomMemo(room, intel, roomCache);
    const structure = (memo.structureById && memo.structureById[mission.targetId]) || Game.getObjectById(mission.targetId);

    return { room, structure, memo };
}

module.exports = {
    makeKey(context) {
        return missionKeys.makeRepairTargetKey(
            context.targetRoom || context.sponsorRoom,
            context.targetId,
            'repair'
        );
    },

    discover({ room, intel }) {
        if (!room) return [];

        const scan = overseerOpportunisticRepair.getRoomScan(room.name);
        if (!scan) return [];

        const structureById = buildStructureByIdIndex(intel, getRoomCache(room));
        const backlog = getRepairBacklogSummary(room, scan, structureById);
        const best = backlog.best;

        writeRepairQueue(room.name, backlog.orderedIds);

        if (!best) return [];
        if (!backlog.gatePassed) return [];

        const createContext = {
            sponsorRoom: room.name,
            targetRoom: room.name,
            targetId: best.id,
            priority: 65
        };

        return [{
            key: this.makeKey(createContext),
            createContext,
            discoveredMeta: {
                targetId: best.id,
                totalDeficitHits: backlog.totalDeficitHits,
                minBacklogHits: backlog.minBacklogHits,
                critical: backlog.critical,
                queueLength: backlog.orderedIds.length
            }
        }];
    },

    create(context) {
        const now = Game.time;
        return {
            id: this.makeKey(context),
            key: this.makeKey(context),
            type: 'repair',
            class: missionClasses.FINITE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.targetRoom || context.sponsorRoom,
            priority: Number.isFinite(context.priority) ? context.priority : 65,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: context.targetId,
            assigned: { primary: [], support: [] },
            demand: { role: 'repairer', count: 1, bodyProfile: 'worker' },
            progress: {
                stage: 'repair',
                lastHits: 0
            },
            meta: {
                missionName: `repair:${context.targetId}`,
                targetHits: null,
                desiredWork: REPAIR_WORKER_TUNING.desiredWork,
                minCount: REPAIR_WORKER_TUNING.minCount,
                maxCount: REPAIR_WORKER_TUNING.maxCount
            },
            statusReason: null
        };
    },

    validate(mission, runtimeCtx) {
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        if (!room) return true;
        const ids = readRepairQueue(roomName);
        if (!ids || ids.length <= 0) return false;
        return true;
    },

    refresh(mission, runtimeCtx) {
        cleanupAssigned(mission);

        const intel = runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null;
        const resolved = getTargetStructure(mission, runtimeCtx);
        const room = resolved.room;
        const structure = resolved.structure;
        const roomMemo = resolved.memo;
        const scan = room ? overseerOpportunisticRepair.getRoomScan(room.name) : null;

        mission.progress = mission.progress || {};
        mission.meta = mission.meta || {};
        mission.meta.missionName = mission.meta.missionName || `repair:${mission.targetId}`;
        mission.meta.desiredWork = REPAIR_WORKER_TUNING.desiredWork;
        mission.meta.minCount = REPAIR_WORKER_TUNING.minCount;
        mission.meta.maxCount = REPAIR_WORKER_TUNING.maxCount;

        let currentTarget = structure;
        if (room && scan) {
            const backlog = getRepairBacklogSummary(room, scan, roomMemo ? roomMemo.structureById : null);
            writeRepairQueue(room.name, backlog.orderedIds);
            if (backlog.best && mission.targetId !== backlog.best.id) mission.targetId = backlog.best.id;
            currentTarget = backlog.best ? ((roomMemo && roomMemo.structureById && roomMemo.structureById[backlog.best.id]) || Game.getObjectById(backlog.best.id)) : null;
        }

        if (currentTarget) {
            const prev = Number.isFinite(mission.progress.lastHits) ? mission.progress.lastHits : currentTarget.hits;
            if (currentTarget.hits > prev) mission.lastProgressTick = Game.time;

            mission.progress.lastHits = currentTarget.hits;
            mission.progress.hitsMax = currentTarget.hitsMax || 0;
            mission.meta.structureType = currentTarget.structureType;
            mission.meta.targetHits = getRepairThreshold(currentTarget);

            const critical = currentTarget.hitsMax > 0 && (currentTarget.hits / currentTarget.hitsMax) < 0.7;
            mission.priority = critical ? 85 : 65;
        }

        mission.demand = {
            role: 'repairer',
            count: Math.max(0, mission.meta.minCount - mission.assigned.primary.length),
            bodyProfile: 'worker'
        };

        mission.data = {
            sourceIds: roomMemo ? roomMemo.sourceIds : [],
            nonMiningContainerIds: roomMemo ? roomMemo.nonMiningContainerIds : getNonMiningContainerIds(room, intel, null),
            allowPartial: true,
            fortify: false,
            targetHits: Number.isFinite(mission.meta.targetHits) ? mission.meta.targetHits : null,
            queueStore: REPAIR_QUEUE_HEAP_STORE,
            queueKey: getRepairQueueKey(room ? room.name : (mission.targetRoom || mission.sponsorRoom))
        };
    },

    isComplete(mission, runtimeCtx) {
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        if (!room) return false;
        const structureById = buildStructureByIdIndex(runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null, getRoomCache(room));
        const ids = readRepairQueue(roomName);
        if (!ids || ids.length <= 0) return true;
        for (let i = 0; i < ids.length; i++) {
            const structure = (structureById && structureById[ids[i]]) || Game.getObjectById(ids[i]);
            if (!structure || isFortifyTarget(structure)) continue;
            if (structure.hits < getRepairThreshold(structure)) return false;
        }
        return true;
    },

    toContractMission(mission) {
        return {
            name: mission.meta && mission.meta.missionName ? mission.meta.missionName : `repair:${mission.targetId}`,
            type: 'repair',
            archetype: 'repairer',
            targetId: mission.targetId,
            data: {
                sourceIds: mission.data && Array.isArray(mission.data.sourceIds) ? mission.data.sourceIds : [],
                nonMiningContainerIds: mission.data && Array.isArray(mission.data.nonMiningContainerIds)
                    ? mission.data.nonMiningContainerIds
                    : [],
                fortify: false,
                allowPartial: true,
                targetHits: mission.data && Number.isFinite(mission.data.targetHits) ? mission.data.targetHits : null
            },
            requirements: {
                archetype: 'repairer',
                requiredWork: REPAIR_WORKER_TUNING.desiredWork,
                minCount: REPAIR_WORKER_TUNING.minCount,
                maxCount: REPAIR_WORKER_TUNING.maxCount,
                maxWorkParts: REPAIR_WORKER_TUNING.maxWorkParts,
                maxCarryParts: REPAIR_WORKER_TUNING.maxCarryParts,
                maxMoveParts: REPAIR_WORKER_TUNING.maxMoveParts,
                spawnFromFleet: true,
                spawn: true
            },
            priority: mission.priority || 65
        };
    }
};
