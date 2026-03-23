const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');

const MAX_SIMPLE_MINING_HAULERS = 4;

function shallowArrayEqual(a, b) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function shallowObjectEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
        const key = aKeys[i];
        if (a[key] !== b[key]) return false;
    }
    return true;
}

function setIfChanged(obj, key, value) {
    if (!obj) return false;
    if (obj[key] === value) return false;
    obj[key] = value;
    return true;
}

function setArrayIfChanged(obj, key, value) {
    if (!obj) return false;
    const next = Array.isArray(value) ? value : [];
    const prev = obj[key];
    if (shallowArrayEqual(prev, next)) return false;
    obj[key] = next.slice();
    return true;
}

function setObjectIfChanged(obj, key, value) {
    if (!obj) return false;
    const next = value && typeof value === 'object' ? value : {};
    const prev = obj[key];
    if (shallowObjectEqual(prev, next)) return false;
    obj[key] = Object.assign({}, next);
    return true;
}

function getRoomCache(room) {
    if (!room || typeof global.getRoomCache !== 'function') return null;
    return global.getRoomCache(room);
}

function getSimpleMiningRoomMemo(room, roomCache) {
    if (!room) {
        return {
            sources: [],
            dropped: [],
            structuresByType: Object.create(null),
            objectById: Object.create(null)
        };
    }
    if (roomCache && roomCache._logisticsSimpleMiningMemo && roomCache._logisticsSimpleMiningMemo.time === Game.time) {
        return roomCache._logisticsSimpleMiningMemo;
    }

    const sources = roomCache && Array.isArray(roomCache.sources) ? roomCache.sources : room.find(FIND_SOURCES);
    const dropped = roomCache && Array.isArray(roomCache.dropped) ? roomCache.dropped : room.find(FIND_DROPPED_RESOURCES);
    const structuresByType = roomCache && roomCache.structuresByType ? roomCache.structuresByType : Object.create(null);
    const objectById = Object.create(null);

    const addObjects = list => {
        if (!Array.isArray(list)) return;
        for (let i = 0; i < list.length; i++) {
            const obj = list[i];
            if (obj && obj.id) objectById[obj.id] = obj;
        }
    };

    addObjects(sources);
    addObjects(dropped);
    addObjects(structuresByType[STRUCTURE_CONTAINER]);
    addObjects(structuresByType[STRUCTURE_STORAGE]);

    const memo = {
        time: Game.time,
        sources,
        dropped,
        structuresByType,
        objectById
    };
    if (roomCache) roomCache._logisticsSimpleMiningMemo = memo;
    return memo;
}

function getObjectByIdCached(id, objectCache, roomMemo) {
    if (!id) return null;
    if (objectCache && objectCache[id] !== undefined) return objectCache[id];
    if (roomMemo && roomMemo.objectById && roomMemo.objectById[id]) {
        if (objectCache) objectCache[id] = roomMemo.objectById[id];
        return roomMemo.objectById[id];
    }
    const obj = Game.getObjectById(id);
    if (objectCache) objectCache[id] = obj || null;
    return obj;
}

function shouldActivate(room) {
    if (!room || !room.controller || !room.controller.my) return false;
    return true;
}

function hasActiveMiningV2Mission(roomName, missionBoardRef) {
    if (!roomName) return false;
    const board = missionBoardRef || require('managers_overseer_missions_board_missionBoard');
    if (!board || typeof board.listLiveByRoom !== 'function') return false;
    const live = board.listLiveByRoom(roomName) || [];
    for (let i = 0; i < live.length; i++) {
        const mission = live[i];
        if (mission && mission.type === 'logisticsMiningV2') return true;
    }
    return false;
}

function getMiningContainerIds(intel) {
    const ids = [];
    const seen = Object.create(null);
    const sources = intel && Array.isArray(intel.sources) ? intel.sources : [];
    for (let i = 0; i < sources.length; i++) {
        const id = sources[i] && sources[i].containerId ? sources[i].containerId : null;
        if (!id || seen[id]) continue;
        seen[id] = true;
        ids.push(id);
    }
    return ids;
}

function getV2UngatedSourceIdSet(intel) {
    const ids = new Set();
    const sources = intel && Array.isArray(intel.sources) ? intel.sources : [];
    for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        if (!source || !source.id || !source.containerId) continue;
        ids.add(source.id);
    }
    return ids;
}

function getSimpleMiningSourceInfos(intel, blockedSourceIds) {
    const sourceInfos = intel && Array.isArray(intel.sources) ? intel.sources : [];
    if (!blockedSourceIds || blockedSourceIds.size <= 0) return sourceInfos;
    return sourceInfos.filter(s => s && s.id && !blockedSourceIds.has(s.id));
}

function getSinkTargets(room, intel, roomMemo) {
    if (!room) return [];
    const miningContainerIdSet = new Set(getMiningContainerIds(intel));
    const sinks = [];

    if (
        room.storage &&
        room.storage.store &&
        typeof room.storage.store.getFreeCapacity === 'function'
    ) {
        const storageFree = room.storage.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
        if (storageFree > 0) sinks.push(room.storage);
    }

    const containers = (intel && intel.structures && intel.structures[STRUCTURE_CONTAINER])
        ? intel.structures[STRUCTURE_CONTAINER]
        : (roomMemo && roomMemo.structuresByType && Array.isArray(roomMemo.structuresByType[STRUCTURE_CONTAINER]))
            ? roomMemo.structuresByType[STRUCTURE_CONTAINER]
        : room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER });
    for (let i = 0; i < containers.length; i++) {
        const container = containers[i];
        if (!container || !container.id || !container.store) continue;
        if (miningContainerIdSet.has(container.id)) continue;
        const free = container.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
        if (free <= 0) continue;
        sinks.push(container);
    }
    return sinks;
}

function isNearAnySource(pos, sourceInfos) {
    if (!pos || !Array.isArray(sourceInfos) || sourceInfos.length <= 0) return false;
    for (let i = 0; i < sourceInfos.length; i++) {
        const source = sourceInfos[i];
        if (!source || !source.pos) continue;
        const sourcePos = source.pos instanceof RoomPosition
            ? source.pos
            : new RoomPosition(source.pos.x, source.pos.y, source.pos.roomName);
        if (!sourcePos || sourcePos.roomName !== pos.roomName) continue;
        if (pos.getRangeTo(sourcePos) <= 1) return true;
    }
    return false;
}

function getSourceIds(room, intel, roomMemo, objectCache) {
    if (!room) return [];
    const ids = [];
    const seen = Object.create(null);
    const sourceInfos = intel && Array.isArray(intel.sources) ? intel.sources : [];
    const miningContainerIds = [];
    for (let i = 0; i < sourceInfos.length; i++) {
        const containerId = sourceInfos[i] && sourceInfos[i].containerId ? sourceInfos[i].containerId : null;
        if (containerId) miningContainerIds.push(containerId);
    }

    function addId(id) {
        if (!id || seen[id]) return;
        seen[id] = true;
        ids.push(id);
    }

    for (let i = 0; i < miningContainerIds.length; i++) {
        const container = getObjectByIdCached(miningContainerIds[i], objectCache, roomMemo);
        if (!container || !container.store || (container.store[RESOURCE_ENERGY] || 0) <= 0) continue;
        addId(container.id);
    }

    const droppedAll = roomMemo && Array.isArray(roomMemo.dropped) ? roomMemo.dropped : room.find(FIND_DROPPED_RESOURCES);
    const dropped = droppedAll.filter(r =>
        r &&
        r.resourceType === RESOURCE_ENERGY &&
        r.amount > 0 &&
        isNearAnySource(r.pos, sourceInfos)
    );
    for (let i = 0; i < dropped.length; i++) addId(dropped[i].id);

    return ids;
}

function estimateSupply(sourceIds, roomMemo, objectCache) {
    if (!Array.isArray(sourceIds) || sourceIds.length <= 0) return 0;
    let total = 0;
    for (let i = 0; i < sourceIds.length; i++) {
        const src = getObjectByIdCached(sourceIds[i], objectCache, roomMemo);
        if (!src) continue;
        if (src.store) total += src.store[RESOURCE_ENERGY] || 0;
        else if (src.resourceType === RESOURCE_ENERGY && Number.isFinite(src.amount)) total += src.amount;
    }
    return total;
}

function estimateSinkFree(sinks) {
    if (!Array.isArray(sinks) || sinks.length <= 0) return 0;
    let total = 0;
    for (let i = 0; i < sinks.length; i++) {
        const sink = sinks[i];
        if (!sink || !sink.store) continue;
        total += sink.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
    }
    return total;
}

function estimateDesiredCount(movableEnergy) {
    if (!Number.isFinite(movableEnergy) || movableEnergy <= 0) return 0;
    return Math.max(1, Math.min(MAX_SIMPLE_MINING_HAULERS, Math.ceil(movableEnergy / 600)));
}

function getEnergySourceCount(room, intel, blockedSourceIds) {
    if (intel && Array.isArray(intel.sources)) {
        return getSimpleMiningSourceInfos(intel, blockedSourceIds).length;
    }
    if (!room) return 0;
    const cache = getRoomCache(room);
    const memo = getSimpleMiningRoomMemo(room, cache);
    const sources = memo.sources;
    return Array.isArray(sources) ? sources.length : 0;
}

function estimateRequiredCarry(movableEnergy, desiredCount) {
    if (!Number.isFinite(movableEnergy) || movableEnergy <= 0 || desiredCount <= 0) return 0;
    const perHaulerNeed = Math.ceil(movableEnergy / Math.max(1, desiredCount));
    return Math.max(2, Math.min(20, Math.ceil(perHaulerNeed / 100)));
}

function cleanupAssigned(mission) {
    if (!mission.assigned) mission.assigned = { primary: [], support: [] };
    if (!Array.isArray(mission.assigned.primary)) mission.assigned.primary = [];
    const primary = mission.assigned.primary;
    let hasDead = false;
    for (let i = 0; i < primary.length; i++) {
        if (!Game.creeps[primary[i]]) {
            hasDead = true;
            break;
        }
    }
    if (!hasDead) return;
    const alive = [];
    for (let i = 0; i < primary.length; i++) {
        const name = primary[i];
        if (Game.creeps[name]) alive.push(name);
    }
    mission.assigned.primary = alive;
}

module.exports = {
    makeKey(context) {
        return missionKeys.makeUserMissionKey(
            context.targetRoom || context.sponsorRoom,
            'logisticsSimpleMining',
            'simpleMining'
        );
    },

    discover({ room, intel, context, missionBoard }) {
        if (!room) return [];
        const policy = context && context.policy ? context.policy : null;
        const missionGates = policy && policy.missionGates ? policy.missionGates : null;
        if (missionGates && missionGates.logisticsSimpleMining === false) return [];
        if (!shouldActivate(room)) return [];
        if (hasActiveMiningV2Mission(room.name, missionBoard)) return [];

        const blockedSourceIds = getV2UngatedSourceIdSet(intel);
        const simpleSourceCount = getEnergySourceCount(room, intel, blockedSourceIds);
        if (simpleSourceCount <= 0) return [];

        const emergency = (policy && policy.status === 'EMERGENCY') || (context && context.opState === 'EMERGENCY');
        const createContext = {
            sponsorRoom: room.name,
            targetRoom: room.name,
            priority: emergency ? 980 : 87
        };
        return [{
            key: this.makeKey(createContext),
            createContext,
            discoveredMeta: {
                roomName: room.name,
                sourceCount: simpleSourceCount
            }
        }];
    },

    create(context) {
        const now = Game.time;
        const key = this.makeKey(context);
        const roomName = context.targetRoom || context.sponsorRoom;
        return {
            id: key,
            key,
            type: 'logisticsSimpleMining',
            class: missionClasses.SERVICE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: roomName,
            priority: Number.isFinite(context.priority) ? context.priority : 87,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: null,
            assigned: { primary: [], support: [] },
            demand: { role: 'simpleMiningHauler', count: 1, bodyProfile: 'hauler' },
            goal: {
                kind: 'service',
                target: { kind: 'simple_mining_shift', roomName },
                success: { kind: 'shift_active' },
                completion: 'never'
            },
            progress: {
                stage: 'simple_mining_shift',
                goalState: 'seeking_assignment',
                assignedPrimary: 0
            },
            meta: {
                missionName: `logistics:simpleMining:${roomName}`,
                desiredCount: 0
            },
            data: {
                sourceIds: [],
                sinkIds: []
            },
            statusReason: null
        };
    },

    validate(mission, runtimeCtx) {
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        if (!shouldActivate(room)) return false;
        if (hasActiveMiningV2Mission(roomName, null)) return false;
        const intel = runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null;
        if (!intel || !Array.isArray(intel.sources)) return true;
        const blockedSourceIds = getV2UngatedSourceIdSet(intel);
        const simpleSourceInfos = getSimpleMiningSourceInfos(intel, blockedSourceIds);
        return simpleSourceInfos.length > 0;
    },

    refresh(mission, runtimeCtx) {
        cleanupAssigned(mission);

        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        if (!room || !shouldActivate(room)) return;
        const roomMemo = getSimpleMiningRoomMemo(room, getRoomCache(room));
        const objectCache = Object.create(null);
        const intel = runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null;

        const blockedSourceIds = getV2UngatedSourceIdSet(intel);
        const simpleSourceInfos = getSimpleMiningSourceInfos(intel, blockedSourceIds);
        const sinks = getSinkTargets(room, intel, roomMemo);
        const sinkIds = sinks.map(s => s.id);
        const sourceIds = getSourceIds(room, { sources: simpleSourceInfos }, roomMemo, objectCache);
        const sourceCount = getEnergySourceCount(room, intel, blockedSourceIds);
        const supply = estimateSupply(sourceIds, roomMemo, objectCache);
        const sinkFree = estimateSinkFree(sinks);
        const movableEnergy = Math.max(0, Math.min(supply, sinkFree));
        const desiredCount = Math.max(0, Math.min(sourceCount, estimateDesiredCount(movableEnergy)));
        const requiredCarry = estimateRequiredCarry(movableEnergy, desiredCount);

        setIfChanged(mission, 'targetId', sinkIds.length > 0 ? sinkIds[0] : null);
        mission.meta = mission.meta || {};
        setIfChanged(mission.meta, 'desiredCount', desiredCount);
        setIfChanged(mission.meta, 'maxBySources', sourceCount);
        setIfChanged(mission.meta, 'requiredCarry', requiredCarry);
        if (!mission.meta.missionName) setIfChanged(mission.meta, 'missionName', `logistics:simpleMining:${roomName}`);

        const nextRequirements = {
            archetype: 'simpleMiningHauler',
            minCount: desiredCount,
            maxCount: desiredCount,
            requiredCarry,
            spawn: true,
            spawnFromFleet: false
        };
        setObjectIfChanged(mission, 'requirements', nextRequirements);

        const nextDemand = {
            role: 'simpleMiningHauler',
            count: Math.max(0, desiredCount - mission.assigned.primary.length),
            bodyProfile: 'hauler'
        };
        setObjectIfChanged(mission, 'demand', nextDemand);

        mission.data = mission.data || {};
        setArrayIfChanged(mission.data, 'sourceIds', sourceIds);
        setArrayIfChanged(mission.data, 'sinkIds', sinkIds);

        mission.progress = mission.progress || {};
        setIfChanged(mission.progress, 'stage', 'simple_mining_shift');
        setIfChanged(mission.progress, 'goalState', mission.assigned.primary.length > 0 ? 'sustaining' : 'seeking_assignment');
        setIfChanged(mission.progress, 'assignedPrimary', mission.assigned.primary.length);
        setIfChanged(mission.progress, 'sourceCount', sourceIds.length);
        setIfChanged(mission.progress, 'energySourceCount', sourceCount);
        setIfChanged(mission.progress, 'sinkCount', sinkIds.length);
        setIfChanged(mission.progress, 'sourceSupply', supply);
        setIfChanged(mission.progress, 'sinkFree', sinkFree);
        setIfChanged(mission.progress, 'movableEnergy', movableEnergy);
        setIfChanged(mission.progress, 'requiredCarry', requiredCarry);
        if (mission.assigned.primary.length > 0) setIfChanged(mission, 'lastProgressTick', Game.time);
    },

    isComplete() {
        return false;
    },

    toContractMission(mission) {
        return {
            name: mission && mission.meta && mission.meta.missionName
                ? mission.meta.missionName
                : `logistics:simpleMining:${(mission && (mission.targetRoom || mission.sponsorRoom)) || 'room'}`,
            type: 'simple_mining_haul',
            archetype: 'simpleMiningHauler',
            targetId: mission && mission.targetId ? mission.targetId : null,
            data: mission && mission.data ? mission.data : {},
            requirements: mission && mission.requirements ? mission.requirements : {
                archetype: 'simpleMiningHauler',
                minCount: 0,
                maxCount: 0,
                requiredCarry: 0,
                spawn: true,
                spawnFromFleet: false
            },
            priority: mission && Number.isFinite(mission.priority) ? mission.priority : 87
        };
    }
};
