const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');
const missionRuntime = require('managers_overseer_missions_board_missionRuntime');

const REBUILD_INTERVAL = 51;
const PLAIN_COST = 10;
const SWAMP_COST = 30;
const MIN_HAULERS = 1;
const MAX_HAULERS = 3;
const SOURCE_ENERGY_PER_TICK = 10;

function posKey(pos) {
    return pos ? `${pos.roomName}:${pos.x},${pos.y}` : '';
}

function clonePos(pos) {
    if (!pos) return null;
    return new RoomPosition(pos.x, pos.y, pos.roomName);
}

function cleanupAssigned(mission) {
    if (!mission.assigned) mission.assigned = { primary: [], support: [] };
    if (!Array.isArray(mission.assigned.primary)) mission.assigned.primary = [];
    mission.assigned.primary = mission.assigned.primary.filter(name => !!Game.creeps[name]);
}

function getStoreAmount(obj, resourceType) {
    if (!obj || !resourceType) return 0;
    if (obj.store) return obj.store[resourceType] || 0;
    if (obj.resourceType === resourceType && Number.isFinite(obj.amount)) return obj.amount;
    return 0;
}

function getSourceInfo(intel, sourceId) {
    const list = intel && Array.isArray(intel.sources) ? intel.sources : [];
    for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (s && s.id === sourceId) return s;
    }
    return null;
}

function hasStableSink(room, intel) {
    if (!room) return false;
    if (room.storage) return true;
    const miningContainerIds = new Set((intel && intel.sources ? intel.sources : []).map(s => s && s.containerId).filter(Boolean));
    const containers = (intel && intel.structures && intel.structures[STRUCTURE_CONTAINER]) || [];
    for (let i = 0; i < containers.length; i++) {
        const c = containers[i];
        if (!c || !c.id || miningContainerIds.has(c.id)) continue;
        return true;
    }
    return false;
}

function isWalkableStructure(structure) {
    if (!structure) return true;
    const type = structure.structureType;
    if (type === STRUCTURE_ROAD) return true;
    if (type === STRUCTURE_CONTAINER) return true;
    if (type === STRUCTURE_RAMPART && (structure.my || structure.isPublic)) return true;
    return false;
}

function getSourceAnchorPos(room, sourcePos) {
    if (!room || !sourcePos) return null;
    const terrain = room.getTerrain();
    let best = null;
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const x = sourcePos.x + dx;
            const y = sourcePos.y + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

            const structures = room.lookForAt(LOOK_STRUCTURES, x, y) || [];
            let blocked = false;
            for (let i = 0; i < structures.length; i++) {
                if (!isWalkableStructure(structures[i])) {
                    blocked = true;
                    break;
                }
            }
            if (blocked) continue;
            const pos = new RoomPosition(x, y, room.name);
            if (!best) best = pos;
            if (terrain.get(x, y) !== TERRAIN_MASK_SWAMP) return pos;
        }
    }
    return best;
}

function findDroppedAtSource(room, sourcePos) {
    if (!room || !sourcePos) return null;
    const dropped = room.find(FIND_DROPPED_RESOURCES, {
        filter: r =>
            r &&
            r.resourceType === RESOURCE_ENERGY &&
            r.amount > 0 &&
            r.pos &&
            r.pos.getRangeTo(sourcePos) <= 1
    });
    if (!dropped || dropped.length <= 0) return null;
    dropped.sort((a, b) => b.amount - a.amount);
    return dropped[0];
}

function resolvePickupAnchor(room, mission, sourceInfo) {
    const source = Game.getObjectById(mission.targetId);
    const sourcePos = source && source.pos
        ? source.pos
        : (sourceInfo && sourceInfo.pos ? new RoomPosition(sourceInfo.pos.x, sourceInfo.pos.y, sourceInfo.pos.roomName) : null);
    if (!sourcePos || sourcePos.roomName !== room.name) return null;

    const containerId = sourceInfo && sourceInfo.containerId ? sourceInfo.containerId : null;
    if (containerId) {
        const container = Game.getObjectById(containerId);
        if (container && container.pos) {
            return {
                pickupId: container.id,
                pickupPos: clonePos(container.pos),
                pickupType: 'container'
            };
        }
    }

    const dropped = findDroppedAtSource(room, sourcePos);
    if (dropped && dropped.pos) {
        return {
            pickupId: null,
            pickupPos: clonePos(dropped.pos),
            pickupType: 'drop'
        };
    }

    const anchor = getSourceAnchorPos(room, sourcePos);
    if (!anchor) return null;
    return {
        pickupId: null,
        pickupPos: clonePos(anchor),
        pickupType: 'drop'
    };
}

function resolveSink(room, intel, pickupPos) {
    if (!room || !pickupPos) return null;
    const sinks = [];
    if (room.storage) sinks.push(room.storage);

    const miningContainerIds = new Set((intel && intel.sources ? intel.sources : []).map(s => s && s.containerId).filter(Boolean));
    const containers = (intel && intel.structures && intel.structures[STRUCTURE_CONTAINER]) || [];
    for (let i = 0; i < containers.length; i++) {
        const c = containers[i];
        if (!c || !c.id || miningContainerIds.has(c.id)) continue;
        sinks.push(c);
    }
    if (sinks.length <= 0) return null;

    let best = sinks[0];
    let bestRange = pickupPos.getRangeTo(best.pos);
    for (let i = 1; i < sinks.length; i++) {
        const s = sinks[i];
        const range = pickupPos.getRangeTo(s.pos);
        if (range < bestRange) {
            best = s;
            bestRange = range;
        }
    }
    return best;
}

function buildRoomCostMatrix(room, startPos, endPos) {
    const matrix = new PathFinder.CostMatrix();
    if (!room) return matrix;

    const terrain = room.getTerrain();
    for (let y = 0; y < 50; y++) {
        for (let x = 0; x < 50; x++) {
            const t = terrain.get(x, y);
            if (t === TERRAIN_MASK_WALL) matrix.set(x, y, 255);
            else if (t === TERRAIN_MASK_SWAMP) matrix.set(x, y, SWAMP_COST);
            else matrix.set(x, y, PLAIN_COST);
        }
    }

    const structures = room.find(FIND_STRUCTURES);
    for (let i = 0; i < structures.length; i++) {
        const s = structures[i];
        if (!s || !s.pos) continue;
        if (s.structureType === STRUCTURE_ROAD) {
            matrix.set(s.pos.x, s.pos.y, 2);
            continue;
        }
        if (!isWalkableStructure(s)) matrix.set(s.pos.x, s.pos.y, 255);
    }

    if (startPos) matrix.set(startPos.x, startPos.y, 1);
    if (endPos) matrix.set(endPos.x, endPos.y, 1);
    return matrix;
}

function buildPath(room, startPos, endPos) {
    if (!room || !startPos || !endPos) return null;
    if (startPos.roomName !== room.name || endPos.roomName !== room.name) return null;
    const costMatrix = buildRoomCostMatrix(room, startPos, endPos);
    const result = PathFinder.search(
        startPos,
        { pos: endPos, range: 1 },
        {
            maxOps: 4000,
            plainCost: PLAIN_COST,
            swampCost: SWAMP_COST,
            roomCallback: roomName => {
                if (roomName !== room.name) return false;
                return costMatrix;
            }
        }
    );
    if (!result || !Array.isArray(result.path) || result.path.length <= 0 || result.incomplete) return null;
    const path = [clonePos(startPos)].concat(result.path);
    const indexByPos = Object.create(null);
    for (let i = 0; i < path.length; i++) {
        const key = posKey(path[i]);
        if (indexByPos[key] === undefined) indexByPos[key] = i;
    }
    return {
        path,
        indexByPos,
        pathLength: path.length
    };
}

function getAssignedMiningHaulers(missionId, roomName, missionName) {
    const assigned = [];
    for (const name in Game.creeps) {
        const creep = Game.creeps[name];
        if (!creep || !creep.my || !creep.memory) continue;
        if (creep.memory.role !== 'miningLaneHauler') continue;
        const idMatch = creep.memory.miningLaneMissionId === missionId || creep.memory.missionId === missionId;
        const nameMatch = missionName && creep.memory.missionName === missionName;
        if (!idMatch && !nameMatch) continue;
        if (roomName && creep.memory.room && creep.memory.room !== roomName) continue;
        assigned.push(creep.name);
    }
    return assigned;
}

function getAssignedCarryParts(names) {
    if (!Array.isArray(names) || names.length <= 0) return 0;
    let total = 0;
    for (let i = 0; i < names.length; i++) {
        const creep = Game.creeps[names[i]];
        if (!creep || !creep.my) continue;
        total += creep.getActiveBodyparts(CARRY);
    }
    return total;
}

function getEstimatedCarryPerHauler(room) {
    if (!room) return 3;
    const cap = Math.max(300, room.energyCapacityAvailable || 300);
    return Math.max(2, Math.min(25, Math.floor(cap / 100)));
}

function estimateRequiredCarryParts(pathLength) {
    const roundTripTicks = Math.max(8, (Math.max(1, pathLength || 1) * 2) + 4);
    return Math.max(1, Math.ceil((SOURCE_ENERGY_PER_TICK * roundTripTicks) / 50));
}

function shouldActivateSource(room, intel, context, sourceInfo) {
    if (!room || !sourceInfo || !sourceInfo.id) return false;
    const efficientSources = context && context.efficientSources ? context.efficientSources : null;
    if (!efficientSources || !efficientSources.has(sourceInfo.id)) return false;
    if (!hasStableSink(room, intel)) return false;
    if (sourceInfo.containerId) return true;

    const sourcePos = sourceInfo.pos ? new RoomPosition(sourceInfo.pos.x, sourceInfo.pos.y, sourceInfo.pos.roomName) : null;
    const dropped = sourcePos ? findDroppedAtSource(room, sourcePos) : null;
    return !!(dropped && dropped.amount >= 25);
}

module.exports = {
    makeKey(context) {
        return missionKeys.makeUserMissionKey(
            context.targetRoom || context.sponsorRoom,
            'logisticsMiningV2',
            context.sourceId
        );
    },

    reconcileRoom({ room, intel, context, missionBoard }) {
        if (!room || !intel || !missionBoard) return;
        if (!hasStableSink(room, intel)) return;
        if (!missionThrottle.shouldRunReconcile('logisticsMiningV2', room.name, Game.time)) return;

        const sources = Array.isArray(intel.sources) ? intel.sources : [];
        for (let i = 0; i < sources.length; i++) {
            const sourceInfo = sources[i];
            if (!shouldActivateSource(room, intel, context, sourceInfo)) continue;
            missionBoard.createMission('logisticsMiningV2', {
                sponsorRoom: room.name,
                targetRoom: room.name,
                sourceId: sourceInfo.id,
                priority: 88
            }, { room, intel, context });
        }
    },

    create(context) {
        const now = Game.time;
        const key = this.makeKey(context);
        return {
            id: key,
            key,
            type: 'logisticsMiningV2',
            class: missionClasses.SERVICE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.targetRoom || context.sponsorRoom,
            priority: Number.isFinite(context.priority) ? context.priority : 88,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: context.sourceId,
            assigned: { primary: [], support: [] },
            demand: { role: 'miningLaneHauler', count: 1, bodyProfile: 'hauler' },
            goal: {
                kind: 'service',
                target: { kind: 'source', roomName: context.targetRoom || context.sponsorRoom, id: context.sourceId },
                success: { kind: 'mining_lane_sustained' },
                completion: 'never'
            },
            progress: {
                stage: 'mining_lane',
                goalState: 'seeking_assignment',
                pathLength: 0,
                assignedPrimary: 0
            },
            meta: {
                missionName: `logistics:miningV2:${context.sourceId}`,
                sourceId: context.sourceId,
                desiredCount: 1,
                pickupId: null,
                sinkId: null
            },
            statusReason: null
        };
    },

    validate(mission, runtimeCtx) {
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        if (!room || !room.controller || !room.controller.my) return false;
        const intel = runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null;
        if (!hasStableSink(room, intel)) return false;
        const sourceInfo = getSourceInfo(intel, mission.targetId);
        if (!sourceInfo) return false;
        const efficientSources = runtimeCtx && runtimeCtx.context && runtimeCtx.context.efficientSources
            ? runtimeCtx.context.efficientSources
            : null;
        if (!efficientSources || !efficientSources.has(sourceInfo.id)) return false;
        return true;
    },

    refresh(mission, runtimeCtx) {
        cleanupAssigned(mission);

        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        if (!room) return;
        const intel = runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null;

        const sourceInfo = getSourceInfo(intel, mission.targetId) || null;
        const pickup = resolvePickupAnchor(room, mission, sourceInfo);
        if (!pickup || !pickup.pickupPos) return;
        const sink = resolveSink(room, intel, pickup.pickupPos);
        if (!sink || !sink.pos) return;

        const runtime = missionRuntime.getMissionRuntime(mission);
        const pickupKey = posKey(pickup.pickupPos);
        const sinkKey = posKey(sink.pos);
        const shouldRebuild =
            !runtime.path ||
            !Array.isArray(runtime.path) ||
            runtime.path.length <= 0 ||
            runtime.pickupKey !== pickupKey ||
            runtime.sinkKey !== sinkKey ||
            !Number.isFinite(runtime.lastBuiltTick) ||
            (Game.time - runtime.lastBuiltTick) >= REBUILD_INTERVAL;

        if (shouldRebuild) {
            const built = buildPath(room, pickup.pickupPos, sink.pos);
            if (built) {
                runtime.path = built.path;
                runtime.indexByPos = built.indexByPos;
                runtime.pathLength = built.pathLength;
                runtime.pickupPos = clonePos(pickup.pickupPos);
                runtime.sinkPos = clonePos(sink.pos);
                runtime.pickupId = pickup.pickupId || null;
                runtime.pickupType = pickup.pickupType || 'drop';
                runtime.sinkId = sink.id;
            }
            runtime.pickupKey = pickupKey;
            runtime.sinkKey = sinkKey;
            runtime.lastBuiltTick = Game.time;
        } else {
            runtime.pickupId = pickup.pickupId || runtime.pickupId || null;
            runtime.pickupType = pickup.pickupType || runtime.pickupType || 'drop';
            runtime.sinkId = sink.id;
            runtime.pickupPos = clonePos(pickup.pickupPos);
            runtime.sinkPos = clonePos(sink.pos);
        }

        runtime.assignedCreeps = getAssignedMiningHaulers(mission.id, room.name, mission.meta && mission.meta.missionName);
        mission.assigned.primary = runtime.assignedCreeps.slice();
        const assignedCarryParts = getAssignedCarryParts(mission.assigned.primary);
        const estimatedCarryPerHauler = getEstimatedCarryPerHauler(room);
        const neededCarryParts = estimateRequiredCarryParts(runtime.pathLength || 0);
        const desiredCount = Math.max(
            MIN_HAULERS,
            Math.min(MAX_HAULERS, Math.ceil(neededCarryParts / Math.max(1, estimatedCarryPerHauler)))
        );

        mission.meta = mission.meta || {};
        mission.meta.sourceId = mission.targetId;
        mission.meta.pickupId = runtime.pickupId || null;
        mission.meta.sinkId = runtime.sinkId || null;
        mission.meta.pathLength = runtime.pathLength || 0;
        mission.meta.pickupType = runtime.pickupType || 'drop';
        mission.meta.desiredCount = desiredCount;
        mission.meta.neededCarryParts = neededCarryParts;
        mission.meta.assignedCarryParts = assignedCarryParts;
        if (!mission.meta.missionName) mission.meta.missionName = `logistics:miningV2:${mission.targetId}`;

        mission.requirements = {
            archetype: 'miningLaneHauler',
            minCount: desiredCount,
            maxCount: desiredCount,
            requiredCarry: neededCarryParts,
            spawn: true,
            spawnFromFleet: false
        };
        mission.demand = {
            role: 'miningLaneHauler',
            count: Math.max(0, desiredCount - mission.assigned.primary.length),
            bodyProfile: 'hauler'
        };
        mission.progress = mission.progress || {};
        mission.progress.stage = 'mining_lane';
        mission.progress.goalState = mission.assigned.primary.length > 0 ? 'sustaining' : 'seeking_assignment';
        mission.progress.pathLength = runtime.pathLength || 0;
        mission.progress.neededCarryParts = neededCarryParts;
        mission.progress.assignedCarryParts = assignedCarryParts;
        mission.progress.desiredCount = desiredCount;
        mission.progress.assignedPrimary = mission.assigned.primary.length;
        mission.lastProgressTick = Game.time;
    },

    isComplete() {
        return false;
    },

    toContractMission(mission) {
        const desiredCount = mission && mission.meta && Number.isFinite(mission.meta.desiredCount)
            ? Math.max(1, Math.floor(mission.meta.desiredCount))
            : 1;
        const neededCarryParts = mission && mission.meta && Number.isFinite(mission.meta.neededCarryParts)
            ? Math.max(1, Math.floor(mission.meta.neededCarryParts))
            : desiredCount;
        return {
            name: mission && mission.meta && mission.meta.missionName
                ? mission.meta.missionName
                : `logistics:miningV2:${(mission && mission.targetId) || 'source'}`,
            type: 'mining_lane_v2',
            archetype: 'miningLaneHauler',
            roleCensus: 'miningLaneHauler',
            requirements: {
                archetype: 'miningLaneHauler',
                minCount: desiredCount,
                maxCount: desiredCount,
                requiredCarry: neededCarryParts,
                spawn: true,
                spawnFromFleet: false
            },
            data: {
                sourceId: mission && mission.targetId ? mission.targetId : null,
                pickupId: mission && mission.meta ? mission.meta.pickupId : null,
                sinkId: mission && mission.meta ? mission.meta.sinkId : null,
                pathLength: mission && mission.meta && Number.isFinite(mission.meta.pathLength) ? mission.meta.pathLength : 0
            },
            priority: mission && Number.isFinite(mission.priority) ? mission.priority : 88
        };
    }
};
