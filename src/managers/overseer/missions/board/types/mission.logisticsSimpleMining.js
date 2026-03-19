const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');

const CORE_END_FLAG = 'CORE_END';
const MAX_SIMPLE_MINING_HAULERS = 4;

function hasCoreLaneFlag(room) {
    if (!room) return false;
    const flag = Game.flags[CORE_END_FLAG];
    return !!(flag && flag.pos && flag.pos.roomName === room.name);
}

function hasEfficientMiningInfra(room) {
    if (!room) return false;
    return !!room.storage && hasCoreLaneFlag(room);
}

function shouldActivate(room) {
    if (!room || !room.controller || !room.controller.my) return false;
    return !hasEfficientMiningInfra(room);
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

function getSinkTargets(room, intel) {
    if (!room) return [];
    const miningContainerIdSet = new Set(getMiningContainerIds(intel));
    const containers = (intel && intel.structures && intel.structures[STRUCTURE_CONTAINER])
        ? intel.structures[STRUCTURE_CONTAINER]
        : room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER });
    const sinks = [];
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

function getSourceIds(room, intel) {
    if (!room) return [];
    const ids = [];
    const seen = Object.create(null);
    const sourceInfos = intel && Array.isArray(intel.sources) ? intel.sources : [];
    const miningContainerIds = getMiningContainerIds(intel);

    function addId(id) {
        if (!id || seen[id]) return;
        seen[id] = true;
        ids.push(id);
    }

    for (let i = 0; i < miningContainerIds.length; i++) {
        const container = Game.getObjectById(miningContainerIds[i]);
        if (!container || !container.store || (container.store[RESOURCE_ENERGY] || 0) <= 0) continue;
        addId(container.id);
    }

    const dropped = room.find(FIND_DROPPED_RESOURCES, {
        filter: r =>
            r &&
            r.resourceType === RESOURCE_ENERGY &&
            r.amount > 0 &&
            isNearAnySource(r.pos, sourceInfos)
    });
    for (let i = 0; i < dropped.length; i++) addId(dropped[i].id);

    return ids;
}

function estimateSupply(sourceIds) {
    if (!Array.isArray(sourceIds) || sourceIds.length <= 0) return 0;
    let total = 0;
    for (let i = 0; i < sourceIds.length; i++) {
        const src = Game.getObjectById(sourceIds[i]);
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

function getEnergySourceCount(room, intel) {
    if (intel && Array.isArray(intel.sources)) return intel.sources.length;
    if (!room) return 0;
    const sources = room.find(FIND_SOURCES);
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
    mission.assigned.primary = mission.assigned.primary.filter(name => !!Game.creeps[name]);
}

module.exports = {
    makeKey(context) {
        return missionKeys.makeUserMissionKey(
            context.targetRoom || context.sponsorRoom,
            'logisticsSimpleMining',
            'simpleMining'
        );
    },

    reconcileRoom({ room, intel, context, missionBoard }) {
        if (!room || !missionBoard) return;
        if (!missionThrottle.shouldRunReconcile('logisticsSimpleMining', room.name, Game.time)) return;
        if (!shouldActivate(room)) return;

        missionBoard.createMission('logisticsSimpleMining', {
            sponsorRoom: room.name,
            targetRoom: room.name,
            priority: context && context.opState === 'EMERGENCY' ? 980 : 87
        }, { room, intel, context });
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
        return shouldActivate(room);
    },

    refresh(mission, runtimeCtx) {
        cleanupAssigned(mission);

        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        if (!room || !shouldActivate(room)) return;
        const intel = runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null;

        const sinks = getSinkTargets(room, intel);
        const sinkIds = sinks.map(s => s.id);
        const sourceIds = getSourceIds(room, intel);
        const sourceCount = getEnergySourceCount(room, intel);
        const supply = estimateSupply(sourceIds);
        const sinkFree = estimateSinkFree(sinks);
        const movableEnergy = Math.max(0, Math.min(supply, sinkFree));
        const desiredCount = Math.max(0, Math.min(sourceCount, estimateDesiredCount(movableEnergy)));
        const requiredCarry = estimateRequiredCarry(movableEnergy, desiredCount);

        mission.targetId = sinkIds.length > 0 ? sinkIds[0] : null;
        mission.meta = mission.meta || {};
        mission.meta.desiredCount = desiredCount;
        mission.meta.maxBySources = sourceCount;
        mission.meta.requiredCarry = requiredCarry;
        if (!mission.meta.missionName) mission.meta.missionName = `logistics:simpleMining:${roomName}`;

        mission.requirements = {
            archetype: 'simpleMiningHauler',
            minCount: desiredCount,
            maxCount: desiredCount,
            requiredCarry,
            spawn: true,
            spawnFromFleet: false
        };
        mission.demand = {
            role: 'simpleMiningHauler',
            count: Math.max(0, desiredCount - mission.assigned.primary.length),
            bodyProfile: 'hauler'
        };
        mission.data = mission.data || {};
        mission.data.sourceIds = sourceIds;
        mission.data.sinkIds = sinkIds;

        mission.progress = mission.progress || {};
        mission.progress.stage = 'simple_mining_shift';
        mission.progress.goalState = mission.assigned.primary.length > 0 ? 'sustaining' : 'seeking_assignment';
        mission.progress.assignedPrimary = mission.assigned.primary.length;
        mission.progress.sourceCount = sourceIds.length;
        mission.progress.energySourceCount = sourceCount;
        mission.progress.sinkCount = sinkIds.length;
        mission.progress.sourceSupply = supply;
        mission.progress.sinkFree = sinkFree;
        mission.progress.movableEnergy = movableEnergy;
        mission.progress.requiredCarry = requiredCarry;
        if (mission.assigned.primary.length > 0) mission.lastProgressTick = Game.time;
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
