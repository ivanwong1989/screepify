const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const overseerOpportunisticRepair = require('managers_overseer_intel_overseer.opportunistic.repair');
const heap = require('utils_heap');

const DEFAULT_FORTIFY_TARGET = 500000;
const FORTIFY_TARGET_CAP = 1;
const WORKER_SET_COST = 200;
const MIN_FORTIFY_BACKLOG_TICKS = 150;
const MIN_FORTIFY_BACKLOG_HITS_FLOOR = 50000;
const FORTIFY_QUEUE_HEAP_STORE = 'missionFortifyQueue';
const FORTIFY_SETTINGS = {
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

const FORTIFY_WORKER_TUNING = Object.freeze({
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

function getFortifyPolicyTarget(room) {
    const policyTarget = room && room.memory && room.memory.overseer && room.memory.overseer.fortifyPolicy
        ? room.memory.overseer.fortifyPolicy.target
        : null;

    if (Number.isFinite(policyTarget)) return policyTarget;

    const rcl = room && room.controller ? room.controller.level : 0;
    const defaults = FORTIFY_SETTINGS[rcl] || FORTIFY_SETTINGS[0];
    if (Number.isFinite(defaults && defaults.target)) return defaults.target;

    return DEFAULT_FORTIFY_TARGET;
}

function getMissionFortifyTargetHits(room, structure, existingTarget) {
    const base = getFortifyPolicyTarget(room);
    const target = Number.isFinite(base) ? base : existingTarget;

    if (!Number.isFinite(target) || target <= 0) return 0;

    if (structure && Number.isFinite(structure.hitsMax) && structure.hitsMax > 0) {
        return Math.min(target, structure.hitsMax);
    }

    return target;
}

function getMaxWorkPartsForRoom(room) {
    if (!room) return 1;
    const capacity = Number.isFinite(room.energyCapacityAvailable) ? room.energyCapacityAvailable : 0;
    if (capacity <= 0) return 1;
    return Math.max(1, Math.min(FORTIFY_WORKER_TUNING.maxWorkParts, Math.floor(capacity / WORKER_SET_COST)));
}

function getMinFortifyBacklogHits(room) {
    const workParts = getMaxWorkPartsForRoom(room);
    const projected = workParts * REPAIR_POWER * MIN_FORTIFY_BACKLOG_TICKS;
    return Math.max(MIN_FORTIFY_BACKLOG_HITS_FLOOR, projected);
}

function getFortifyQueueStore() {
    return heap.getStore(FORTIFY_QUEUE_HEAP_STORE, { ttl: null });
}

function getFortifyQueueKey(roomName) {
    return `fortify:${roomName || ''}`;
}

function writeFortifyQueue(roomName, ids) {
    if (!roomName) return;
    const store = getFortifyQueueStore();
    store[getFortifyQueueKey(roomName)] = {
        time: Game.time,
        ids: Array.isArray(ids) ? ids.slice() : []
    };
}

function readFortifyQueue(roomName) {
    if (!roomName) return [];
    const store = getFortifyQueueStore();
    const entry = store[getFortifyQueueKey(roomName)];
    return entry && Array.isArray(entry.ids) ? entry.ids : [];
}

function getFortifyBacklogSummary(room, scan, structureById, fallbackTargetHits) {
    const fortifyIds = scan && Array.isArray(scan.fortifyIds) ? scan.fortifyIds : [];
    const targetHits = Number.isFinite(fallbackTargetHits) ? fallbackTargetHits : getFortifyPolicyTarget(room);
    const candidates = [];
    let totalDeficitHits = 0;

    for (let i = 0; i < fortifyIds.length; i++) {
        const id = fortifyIds[i];
        const structure = (structureById && structureById[id]) || Game.getObjectById(id);
        if (!isFortifyTarget(structure)) continue;
        const structureTargetHits = getMissionFortifyTargetHits(room, structure, targetHits);
        const deficitHits = structureTargetHits - structure.hits;
        if (deficitHits <= 0) continue;

        totalDeficitHits += deficitHits;
        candidates.push({
            id: structure.id,
            ratio: structureTargetHits > 0 ? (structure.hits / structureTargetHits) : 1,
            hits: structure.hits,
            deficitHits
        });
    }

    candidates.sort((a, b) => {
        if (a.ratio !== b.ratio) return a.ratio - b.ratio;
        if (a.deficitHits !== b.deficitHits) return b.deficitHits - a.deficitHits;
        return a.id < b.id ? -1 : 1;
    });

    const minBacklogHits = getMinFortifyBacklogHits(room);
    const gatePassed = totalDeficitHits >= minBacklogHits;
    return { candidates, totalDeficitHits, minBacklogHits, targetHits, gatePassed };
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

function getFortifyRoomMemo(room, intel, roomCache) {
    if (!room) {
        return {
            sourceIds: [],
            nonMiningContainerIds: [],
            structureById: Object.create(null)
        };
    }

    if (roomCache && roomCache._fortifyMissionMemo && roomCache._fortifyMissionMemo.time === Game.time) {
        return roomCache._fortifyMissionMemo;
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

    if (roomCache) roomCache._fortifyMissionMemo = memo;
    return memo;
}

function getTargetStructure(mission, runtimeCtx) {
    const roomName = mission.targetRoom || mission.sponsorRoom;
    const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
    if (!room) return { room: null, structure: null, memo: null };

    const intel = runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null;
    const roomCache = getRoomCache(room);
    const memo = getFortifyRoomMemo(room, intel, roomCache);
    const structure = (memo.structureById && memo.structureById[mission.targetId]) || Game.getObjectById(mission.targetId);

    return { room, structure, memo };
}

module.exports = {
    makeKey(context) {
        return missionKeys.makeRepairTargetKey(
            context.targetRoom || context.sponsorRoom,
            context.targetId,
            'fortify'
        );
    },

    discover({ room, intel, context }) {
        if (!room) return [];

        const economyState = context && context.economyState ? context.economyState : 'STOCKPILING';
        if (economyState === 'EMERGENCY') return [];

        const scan = overseerOpportunisticRepair.getRoomScan(room.name);
        if (!scan) return [];

        const structureById = buildStructureByIdIndex(intel, getRoomCache(room));
        const backlog = getFortifyBacklogSummary(room, scan, structureById, getFortifyPolicyTarget(room));
        const candidates = backlog.candidates;
        const orderedIds = candidates.map(c => c.id);
        writeFortifyQueue(room.name, orderedIds);

        if (candidates.length <= 0) return [];
        if (!backlog.gatePassed) return [];

        const out = [];
        const cap = Math.max(1, FORTIFY_TARGET_CAP);

        for (let i = 0; i < Math.min(cap, candidates.length); i++) {
            const candidate = candidates[i];
            const createContext = {
                sponsorRoom: room.name,
                targetRoom: room.name,
                targetId: candidate.id,
                targetHits: backlog.targetHits,
                priority: 55
            };

            out.push({
                key: this.makeKey(createContext),
                createContext,
                discoveredMeta: {
                    targetId: candidate.id,
                    totalDeficitHits: backlog.totalDeficitHits,
                    minBacklogHits: backlog.minBacklogHits,
                    queueLength: orderedIds.length
                }
            });
        }

        return out;
    },

    create(context) {
        const now = Game.time;
        return {
            id: this.makeKey(context),
            key: this.makeKey(context),
            type: 'fortify',
            class: missionClasses.FINITE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.targetRoom || context.sponsorRoom,
            priority: Number.isFinite(context.priority) ? context.priority : 55,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: context.targetId,
            assigned: { primary: [], support: [] },
            demand: { role: 'worker', count: 1, bodyProfile: 'worker' },
            progress: {
                stage: 'fortify',
                lastHits: 0
            },
            meta: {
                missionName: `fortify:${context.targetId}`,
                targetHits: Number.isFinite(context.targetHits) ? context.targetHits : null,
                desiredWork: FORTIFY_WORKER_TUNING.desiredWork,
                minCount: FORTIFY_WORKER_TUNING.minCount,
                maxCount: FORTIFY_WORKER_TUNING.maxCount
            },
            statusReason: null
        };
    },

    validate(mission, runtimeCtx) {
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        if (!room) return true;
        const ids = readFortifyQueue(roomName);
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
        mission.meta.missionName = mission.meta.missionName || `fortify:${mission.targetId}`;
        mission.meta.desiredWork = FORTIFY_WORKER_TUNING.desiredWork;
        mission.meta.minCount = FORTIFY_WORKER_TUNING.minCount;
        mission.meta.maxCount = FORTIFY_WORKER_TUNING.maxCount;

        let currentTarget = structure;
        if (room && scan) {
            const fallbackTarget = Number.isFinite(mission.meta.targetHits)
                ? mission.meta.targetHits
                : getFortifyPolicyTarget(room);
            const backlog = getFortifyBacklogSummary(room, scan, roomMemo ? roomMemo.structureById : null, fallbackTarget);
            writeFortifyQueue(room.name, backlog.candidates.map(c => c.id));
            const best = backlog.candidates.length > 0 ? backlog.candidates[0] : null;
            if (best && mission.targetId !== best.id) mission.targetId = best.id;
            currentTarget = best ? ((roomMemo && roomMemo.structureById && roomMemo.structureById[best.id]) || Game.getObjectById(best.id)) : null;
        }

        if (currentTarget) {
            const prev = Number.isFinite(mission.progress.lastHits) ? mission.progress.lastHits : currentTarget.hits;
            if (currentTarget.hits > prev) mission.lastProgressTick = Game.time;

            mission.progress.lastHits = currentTarget.hits;
            mission.progress.hitsMax = currentTarget.hitsMax || 0;
            mission.meta.structureType = currentTarget.structureType;
            mission.meta.targetHits = getMissionFortifyTargetHits(room, currentTarget, mission.meta.targetHits || DEFAULT_FORTIFY_TARGET);
        }

        mission.demand = {
            role: 'worker',
            count: Math.max(0, mission.meta.minCount - mission.assigned.primary.length),
            bodyProfile: 'worker'
        };

        mission.data = {
            sourceIds: roomMemo ? roomMemo.sourceIds : [],
            nonMiningContainerIds: roomMemo ? roomMemo.nonMiningContainerIds : getNonMiningContainerIds(room, intel, null),
            allowPartial: true,
            fortify: true,
            targetHits: Number.isFinite(mission.meta.targetHits) ? mission.meta.targetHits : null,
            queueStore: FORTIFY_QUEUE_HEAP_STORE,
            queueKey: getFortifyQueueKey(room ? room.name : (mission.targetRoom || mission.sponsorRoom))
        };
    },

    isComplete(mission, runtimeCtx) {
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        if (!room) return false;
        const structureById = buildStructureByIdIndex(runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null, getRoomCache(room));
        const ids = readFortifyQueue(roomName);
        if (!ids || ids.length <= 0) return true;
        const fallbackTarget = mission.meta && Number.isFinite(mission.meta.targetHits)
            ? mission.meta.targetHits
            : getFortifyPolicyTarget(room);
        for (let i = 0; i < ids.length; i++) {
            const structure = (structureById && structureById[ids[i]]) || Game.getObjectById(ids[i]);
            if (!isFortifyTarget(structure)) continue;
            const targetHits = getMissionFortifyTargetHits(room, structure, fallbackTarget);
            if (structure.hits < targetHits) return false;
        }
        return true;
    },

    toContractMission(mission) {
        return {
            name: mission.meta && mission.meta.missionName ? mission.meta.missionName : `fortify:${mission.targetId}`,
            type: 'fortify',
            archetype: 'worker',
            targetId: mission.targetId,
            data: {
                sourceIds: mission.data && Array.isArray(mission.data.sourceIds) ? mission.data.sourceIds : [],
                nonMiningContainerIds: mission.data && Array.isArray(mission.data.nonMiningContainerIds)
                    ? mission.data.nonMiningContainerIds
                    : [],
                fortify: true,
                allowPartial: true,
                targetHits: mission.data && Number.isFinite(mission.data.targetHits) ? mission.data.targetHits : null,
                queueStore: mission.data && mission.data.queueStore ? mission.data.queueStore : null,
                queueKey: mission.data && mission.data.queueKey ? mission.data.queueKey : null
            },
            requirements: {
                archetype: 'worker',
                requiredWork: FORTIFY_WORKER_TUNING.desiredWork,
                minCount: FORTIFY_WORKER_TUNING.minCount,
                maxCount: FORTIFY_WORKER_TUNING.maxCount,
                maxWorkParts: FORTIFY_WORKER_TUNING.maxWorkParts,
                maxCarryParts: FORTIFY_WORKER_TUNING.maxCarryParts,
                maxMoveParts: FORTIFY_WORKER_TUNING.maxMoveParts,
                spawnFromFleet: true,
                spawn: true
            },
            priority: mission.priority || 55
        };
    }
};
