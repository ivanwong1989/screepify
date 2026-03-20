const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');
const missionRuntime = require('managers_overseer_missions_board_missionRuntime');

const REBUILD_INTERVAL = 100;
const PLAIN_COST = 10;
const SWAMP_COST = 30;
const CORE_HEAD_AVOID_COST = 200;
const SOURCE_RING_BLOCK_COST = 255;
const MIN_HAULERS = 1;
const MAX_HAULERS = 3;
const SOURCE_ENERGY_PER_TICK = 10;
const LINK_OVERFLOW_ENERGY_PER_TICK = 2;

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

function resolvePickupAnchor(sourceInfo) {
    const containerId = sourceInfo && sourceInfo.containerId ? sourceInfo.containerId : null;
    if (!containerId) return null;
    const container = Game.getObjectById(containerId);
    if (!container || !container.pos) return null;
    return {
        pickupId: container.id,
        pickupPos: clonePos(container.pos)
    };
}

function hasSourceContainer(sourceInfo) {
    if (!sourceInfo || !sourceInfo.containerId) return false;
    const container = Game.getObjectById(sourceInfo.containerId);
    return !!(container && container.structureType === STRUCTURE_CONTAINER && container.pos);
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

function getCoreHeadAvoidTiles(roomName) {
    const avoid = [];
    if (!roomName) return avoid;
    const missionBoard = require('managers_overseer_missions_board_missionBoard');
    const live = missionBoard.listLiveByRoom(roomName) || [];
    for (let i = 0; i < live.length; i++) {
        const mission = live[i];
        if (!mission || mission.type !== 'logisticsCoreV2') continue;
        const runtime = missionRuntime.getMissionRuntime(mission);
        const headPos = runtime && runtime.paths && runtime.paths.core ? runtime.paths.core.headPos : null;
        if (!headPos || headPos.roomName !== roomName) continue;
        avoid.push(clonePos(headPos));
    }
    return avoid;
}

function buildAvoidSignature(positions) {
    if (!Array.isArray(positions) || positions.length <= 0) return '';
    const keys = [];
    const seen = Object.create(null);
    for (let i = 0; i < positions.length; i++) {
        const key = posKey(positions[i]);
        if (!key || seen[key]) continue;
        seen[key] = true;
        keys.push(key);
    }
    keys.sort();
    return keys.join('|');
}

function getMinerStandAvoidTiles(room, intel) {
    const avoid = [];
    if (!room || !intel || !Array.isArray(intel.sources)) return avoid;
    const terrain = room.getTerrain();
    for (let i = 0; i < intel.sources.length; i++) {
        const source = intel.sources[i];
        if (!source || !source.pos || source.pos.roomName !== room.name) continue;
        const sx = source.pos.x;
        const sy = source.pos.y;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                const x = sx + dx;
                const y = sy + dy;
                if (x < 1 || x > 48 || y < 1 || y > 48) continue;
                if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
                avoid.push(new RoomPosition(x, y, room.name));
            }
        }
    }
    return avoid;
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

function applyAvoidTiles(matrix, room, startPos, endPos, avoidTiles, avoidCost, hardBlock) {
    if (!matrix || !room) return;
    if (!Array.isArray(avoidTiles) || avoidTiles.length <= 0) return;
    const penalty = Number.isFinite(avoidCost) ? avoidCost : CORE_HEAD_AVOID_COST;
    const shouldHardBlock = hardBlock === true;
    for (let i = 0; i < avoidTiles.length; i++) {
        const tile = avoidTiles[i];
        if (!tile || tile.roomName !== room.name) continue;
        if (startPos && tile.x === startPos.x && tile.y === startPos.y) continue;
        if (endPos && tile.x === endPos.x && tile.y === endPos.y) continue;
        if (matrix.get(tile.x, tile.y) >= 255) continue;
        if (shouldHardBlock) {
            matrix.set(tile.x, tile.y, 255);
            continue;
        }
        matrix.set(tile.x, tile.y, Math.max(matrix.get(tile.x, tile.y), penalty));
    }
}

function buildPath(room, startPos, endPos, avoidTiles) {
    if (!room || !startPos || !endPos) return null;
    if (startPos.roomName !== room.name || endPos.roomName !== room.name) return null;
    const costMatrix = buildRoomCostMatrix(room, startPos, endPos);
    const coreHeadTiles = [];
    const minerStandTiles = [];
    if (Array.isArray(avoidTiles) && avoidTiles.length > 0) {
        for (let i = 0; i < avoidTiles.length; i++) {
            const entry = avoidTiles[i];
            if (!entry || !entry.pos) continue;
            if (entry.kind === 'core_head') coreHeadTiles.push(entry.pos);
            else if (entry.kind === 'miner_stand') minerStandTiles.push(entry.pos);
        }
    }
    applyAvoidTiles(costMatrix, room, startPos, endPos, coreHeadTiles, CORE_HEAD_AVOID_COST, false);
    // Source-adjacent ring is hard blocked so lane haulers never route through miner standing tiles.
    applyAvoidTiles(costMatrix, room, startPos, endPos, minerStandTiles, SOURCE_RING_BLOCK_COST, true);
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
    // For mining container lanes, do not reserve the container tile itself as a lane endpoint.
    const path = result.path.slice();
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

function estimateRequiredCarryPartsForRate(pathLength, energyPerTick) {
    const roundTripTicks = Math.max(8, (Math.max(1, pathLength || 1) * 2) + 4);
    const rate = Number.isFinite(energyPerTick) ? Math.max(0, energyPerTick) : SOURCE_ENERGY_PER_TICK;
    return Math.max(1, Math.ceil((rate * roundTripTicks) / 50));
}

function hasLinkAssistedSource(room, intel, sourceInfo) {
    if (!room || !sourceInfo || !sourceInfo.id || !sourceInfo.pos || !sourceInfo.linkId) return false;
    const sourceLink = Game.getObjectById(sourceInfo.linkId);
    if (!sourceLink || sourceLink.structureType !== STRUCTURE_LINK || !sourceLink.pos) return false;
    if (!sourceLink.pos.inRangeTo(sourceInfo.pos, 2)) return false;

    const intelSources = intel && Array.isArray(intel.sources) ? intel.sources : [];
    const sourcePosById = Object.create(null);
    for (let i = 0; i < intelSources.length; i++) {
        const s = intelSources[i];
        if (!s || !s.id || !s.pos) continue;
        sourcePosById[s.id] = s.pos;
    }

    const links = room.find(FIND_MY_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_LINK && s.id !== sourceLink.id && !!s.pos
    });
    if (!links || links.length <= 0) return false;

    for (let i = 0; i < links.length; i++) {
        const link = links[i];
        let nearAnySource = false;
        for (const sid in sourcePosById) {
            const spos = sourcePosById[sid];
            if (spos && link.pos.inRangeTo(spos, 2)) {
                nearAnySource = true;
                break;
            }
        }
        if (!nearAnySource) return true;
    }
    return false;
}

function shouldActivateSource(room, intel, sourceInfo) {
    if (!room || !sourceInfo || !sourceInfo.id) return false;
    if (!hasStableSink(room, intel)) return false;
    return hasSourceContainer(sourceInfo);
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
            if (!shouldActivateSource(room, intel, sourceInfo)) continue;
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
        if (!hasSourceContainer(sourceInfo)) return false;
        return true;
    },

    refresh(mission, runtimeCtx) {
        cleanupAssigned(mission);

        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        if (!room) return;
        const intel = runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null;

        const sourceInfo = getSourceInfo(intel, mission.targetId) || null;
        const pickup = resolvePickupAnchor(sourceInfo);
        if (!pickup || !pickup.pickupPos) return;
        const sink = resolveSink(room, intel, pickup.pickupPos);
        if (!sink || !sink.pos) return;
        const runtime = missionRuntime.getMissionRuntime(mission);
        const coreHeadAvoidTiles = getCoreHeadAvoidTiles(room.name);
        const minerStandAvoidTiles = getMinerStandAvoidTiles(room, intel);
        const avoidTiles = [];
        for (let i = 0; i < coreHeadAvoidTiles.length; i++) {
            avoidTiles.push({ kind: 'core_head', pos: coreHeadAvoidTiles[i] });
        }
        for (let i = 0; i < minerStandAvoidTiles.length; i++) {
            avoidTiles.push({ kind: 'miner_stand', pos: minerStandAvoidTiles[i] });
        }
        const avoidSignature = buildAvoidSignature(
            avoidTiles.map(a => a.pos)
        );

        const pickupKey = posKey(pickup.pickupPos);
        const sinkKey = posKey(sink.pos);
        const buildInputsChanged =
            runtime.useLane !== true ||
            runtime.pickupKey !== pickupKey ||
            runtime.sinkKey !== sinkKey ||
            runtime.avoidSignature !== avoidSignature;
        const rebuildIntervalElapsed =
            !Number.isFinite(runtime.lastBuiltTick) ||
            (Game.time - runtime.lastBuiltTick) >= REBUILD_INTERVAL;
        // Retry cadence is interval-based so failed builds do not trigger pathfinding every tick.
        const shouldRebuild = buildInputsChanged || rebuildIntervalElapsed;

        if (shouldRebuild) {
            const built = buildPath(room, pickup.pickupPos, sink.pos, avoidTiles);
            if (built) {
                runtime.path = built.path;
                runtime.indexByPos = built.indexByPos;
                runtime.pathLength = built.pathLength;
            } else {
                runtime.path = null;
                runtime.indexByPos = null;
                runtime.pathLength = 0;
            }
            runtime.pickupKey = pickupKey;
            runtime.sinkKey = sinkKey;
            runtime.avoidSignature = avoidSignature;
            runtime.lastBuiltTick = Game.time;
        }
        runtime.useLane = true;
        runtime.pickupPos = clonePos(pickup.pickupPos);
        runtime.sinkPos = clonePos(sink.pos);
        runtime.pickupId = pickup.pickupId || null;
        runtime.pickupType = 'container';
        runtime.sinkId = sink.id;

        runtime.assignedCreeps = getAssignedMiningHaulers(mission.id, room.name, mission.meta && mission.meta.missionName);
        mission.assigned.primary = runtime.assignedCreeps.slice();
        const assignedCarryParts = getAssignedCarryParts(mission.assigned.primary);
        const estimatedCarryPerHauler = getEstimatedCarryPerHauler(room);
        const laneReady = Array.isArray(runtime.path) && runtime.path.length > 0;
        const effectivePathLength = laneReady
            ? (runtime.pathLength || 0)
            : Math.max(1, pickup.pickupPos.getRangeTo(sink.pos));
        const linkAssistActive = hasLinkAssistedSource(room, intel, sourceInfo);
        const targetEnergyPerTick = linkAssistActive ? LINK_OVERFLOW_ENERGY_PER_TICK : SOURCE_ENERGY_PER_TICK;
        const neededCarryParts = estimateRequiredCarryPartsForRate(effectivePathLength, targetEnergyPerTick);
        const desiredCount = Math.max(
            MIN_HAULERS,
            Math.min(MAX_HAULERS, Math.ceil(neededCarryParts / Math.max(1, estimatedCarryPerHauler)))
        );
        const maxCarryParts = Math.max(2, Math.ceil(neededCarryParts / Math.max(1, desiredCount)));

        mission.meta = mission.meta || {};
        mission.meta.sourceId = mission.targetId;
        mission.meta.pickupId = runtime.pickupId || null;
        mission.meta.sinkId = runtime.sinkId || null;
        mission.meta.pathLength = effectivePathLength;
        mission.meta.pathMode = laneReady ? 'lane_cached' : 'lane_fallback';
        mission.meta.pickupType = 'container';
        mission.meta.desiredCount = desiredCount;
        mission.meta.neededCarryParts = neededCarryParts;
        mission.meta.maxCarryParts = maxCarryParts;
        mission.meta.linkAssistActive = linkAssistActive;
        mission.meta.targetEnergyPerTick = targetEnergyPerTick;
        mission.meta.assignedCarryParts = assignedCarryParts;
        if (!mission.meta.missionName) mission.meta.missionName = `logistics:miningV2:${mission.targetId}`;

        mission.requirements = {
            archetype: 'miningLaneHauler',
            minCount: desiredCount,
            maxCount: desiredCount,
            requiredCarry: neededCarryParts,
            maxCarryParts: maxCarryParts,
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
        mission.progress.pathLength = effectivePathLength;
        mission.progress.neededCarryParts = neededCarryParts;
        mission.progress.maxCarryParts = maxCarryParts;
        mission.progress.linkAssistActive = linkAssistActive ? 1 : 0;
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
        const maxCarryParts = mission && mission.meta && Number.isFinite(mission.meta.maxCarryParts)
            ? Math.max(1, Math.floor(mission.meta.maxCarryParts))
            : null;
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
                maxCarryParts: maxCarryParts,
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
