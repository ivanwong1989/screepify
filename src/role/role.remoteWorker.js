const roleUniversal = require('role_role.universal');
const movement = require('utils_movement');

const REMOTE_WORKER_MISSION_TYPES = new Set(['remote_build']);
const REMOTE_GATHER_RANGE = 20;
const REMOTE_STICKY_TICKS = 25;
const REMOTE_HOME_STICKY_TICKS = 40;
const DEFAULT_ALLOW_ROLES = ['miner', 'staticMiner', 'remoteHarvester', 'remote_miner', 'harvester_remote'];
const DEFAULT_ALLOWED_INFRA = [STRUCTURE_CONTAINER, STRUCTURE_ROAD, STRUCTURE_LINK];

function clearRemoteWorkerAssignment(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.missionName;
    delete creep.memory.task;
    delete creep.memory.taskState;
    delete creep.memory._remoteEnergy;
    delete creep.memory._trafficMove;
}

function toRoomPosition(pos) {
    if (!pos) return null;
    if (pos instanceof RoomPosition) return pos;
    if (!pos.roomName) return null;
    const x = Number(pos.x);
    const y = Number(pos.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return new RoomPosition(x, y, pos.roomName);
}

function getCachedObject(room, id) {
    if (!id) return null;
    if (room && room._idCache && room._idCache.has(id)) return room._idCache.get(id);
    return Game.getObjectById(id);
}

function updateState(creep) {
    const used = creep.store.getUsedCapacity(RESOURCE_ENERGY);
    const free = creep.store.getFreeCapacity(RESOURCE_ENERGY);

    if (creep.memory.taskState === 'working' && used === 0) {
        creep.memory.taskState = 'idle';
    }
    if (creep.memory.taskState === 'gathering' && free === 0) {
        creep.memory.taskState = 'idle';
    }
    if (creep.memory.taskState === 'idle' || creep.memory.taskState === 'init' || !creep.memory.taskState) {
        creep.memory.taskState = used > 0 ? 'working' : 'gathering';
    }
}

function hasFreeHarvestSpot(creep, source) {
    if (!creep || !source || !source.pos || !creep.room) return false;
    const terrain = creep.room.getTerrain();
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const x = source.pos.x + dx;
            const y = source.pos.y + dy;
            if (x < 0 || x > 49 || y < 0 || y > 49) continue;
            if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
            const creeps = creep.room.lookForAt(LOOK_CREEPS, x, y);
            if (creeps && creeps.length > 0 && !(creeps.length === 1 && creeps[0].id === creep.id)) continue;
            return true;
        }
    }
    return false;
}

function getMissionByName(homeRoom, missionName) {
    if (!homeRoom || !missionName) return null;
    if (homeRoom._remoteWorkerMissionMapTick !== Game.time || !homeRoom._remoteWorkerMissionMap) {
        const map = Object.create(null);
        const missions = Array.isArray(homeRoom._missions) ? homeRoom._missions : [];
        for (let i = 0; i < missions.length; i++) {
            const mission = missions[i];
            if (!mission || !mission.name) continue;
            map[mission.name] = mission;
        }
        homeRoom._remoteWorkerMissionMap = map;
        homeRoom._remoteWorkerMissionMapTick = Game.time;
    }
    return homeRoom._remoteWorkerMissionMap[missionName] || null;
}

function executeIntent(creep, intent) {
    if (!intent || !intent.type) return false;

    if (intent.type === 'move') {
        const pos = toRoomPosition(intent.targetPos);
        if (!pos) return false;
        if (!creep.pos.inRangeTo(pos, Number.isFinite(intent.range) ? intent.range : 1)) {
            movement.planMoveTo(creep, pos, {
                range: Number.isFinite(intent.range) ? intent.range : 1,
                maxRooms: (pos.roomName && creep.room && pos.roomName !== creep.room.name) ? 16 : 1
            });
        }
        return true;
    }

    const target = intent.targetId ? Game.getObjectById(intent.targetId) : null;
    if (!target) return false;

    switch (intent.type) {
        case 'build': {
            const result = creep.build(target);
            if (result === ERR_NOT_IN_RANGE) movement.planMoveTo(creep, target, { range: 3, maxRooms: 1 });
            return true;
        }
        case 'harvest': {
            const result = creep.harvest(target);
            if (result === ERR_NOT_IN_RANGE) movement.planMoveTo(creep, target, { range: 1, maxRooms: 1 });
            return true;
        }
        case 'withdraw': {
            const result = creep.withdraw(target, intent.resourceType || RESOURCE_ENERGY);
            if (result === ERR_NOT_IN_RANGE) movement.planMoveTo(creep, target, { range: 1, maxRooms: 1 });
            return true;
        }
        case 'pickup': {
            const result = creep.pickup(target);
            if (result === ERR_NOT_IN_RANGE) movement.planMoveTo(creep, target, { range: 1, maxRooms: 1 });
            return true;
        }
        default:
            return false;
    }
}

function pickHomeGatherIntent(creep, room) {
    if (!creep || !room) return null;
    if (!room._reservedEnergy) room._reservedEnergy = {};

    const cache = global.getRoomCache(room);
    const dropped = creep.pos.findClosestByRange(cache.dropped || [], {
        filter: r => {
            if (r.resourceType !== RESOURCE_ENERGY || r.amount <= 50) return false;
            const reserved = room._reservedEnergy[r.id] || 0;
            return (r.amount - reserved) >= 50;
        }
    });
    if (dropped) {
        room._reservedEnergy[dropped.id] = (room._reservedEnergy[dropped.id] || 0) + creep.store.getFreeCapacity();
        return { type: 'pickup', targetId: dropped.id };
    }

    const storageAndContainers = [
        ...(cache.structuresByType[STRUCTURE_CONTAINER] || []),
        ...(cache.structuresByType[STRUCTURE_STORAGE] || []),
        ...(cache.structuresByType[STRUCTURE_LINK] || [])
    ];
    const structure = creep.pos.findClosestByRange(storageAndContainers, {
        filter: s => {
            const energy = s.store ? (s.store[RESOURCE_ENERGY] || 0) : 0;
            const reserved = room._reservedEnergy[s.id] || 0;
            return (energy - reserved) >= 50;
        }
    });
    if (structure) {
        room._reservedEnergy[structure.id] = (room._reservedEnergy[structure.id] || 0) + creep.store.getFreeCapacity();
        return { type: 'withdraw', targetId: structure.id, resourceType: RESOURCE_ENERGY };
    }

    if (creep.getActiveBodyparts(WORK) > 0) {
        const source = creep.pos.findClosestByRange(cache.sourcesActive || []);
        if (source) return { type: 'harvest', targetId: source.id };
    }

    return null;
}

function getSources(room) {
    if (!room) return [];
    return room.find(FIND_SOURCES) || [];
}

function isNearSource(pos, sources, forbidRange) {
    if (!pos || !sources || sources.length === 0) return false;
    const range = Math.max(1, Math.floor(forbidRange || 1));
    for (let i = 0; i < sources.length; i++) {
        if (pos.getRangeTo(sources[i].pos) <= range) return true;
    }
    return false;
}

function isSourceInfra(structureType, allowedTypes) {
    if (!structureType || !Array.isArray(allowedTypes) || allowedTypes.length === 0) return false;
    return allowedTypes.includes(structureType);
}

function isTargetNearSource(targetPos, sources, forbidRange) {
    if (!targetPos || !sources || sources.length === 0) return false;
    const range = Math.max(1, Math.floor(forbidRange || 1));
    for (let i = 0; i < sources.length; i++) {
        if (targetPos.getRangeTo(sources[i].pos) <= range) return true;
    }
    return false;
}

function isPassableStructure(structure) {
    if (!structure) return true;
    if (structure.structureType === STRUCTURE_ROAD) return true;
    if (structure.structureType === STRUCTURE_CONTAINER) return true;
    if (structure.structureType === STRUCTURE_RAMPART && (structure.my || structure.isPublic)) return true;
    return false;
}

function isWalkablePos(room, x, y) {
    if (!room || x < 0 || x > 49 || y < 0 || y > 49) return false;
    if (room.getTerrain().get(x, y) === TERRAIN_MASK_WALL) return false;
    const structures = room.lookForAt(LOOK_STRUCTURES, x, y);
    for (let i = 0; i < structures.length; i++) {
        if (!isPassableStructure(structures[i])) return false;
    }
    return true;
}

function isOccupied(room, x, y, creepId) {
    if (!room) return false;
    const creeps = room.lookForAt(LOOK_CREEPS, x, y);
    if (!creeps || creeps.length === 0) return false;
    if (creepId && creeps.length === 1 && creeps[0].id === creepId) return false;
    return true;
}

function getCandidatePositionsAroundTarget(room, targetPos, workRange) {
    const candidates = [];
    if (!room || !targetPos) return candidates;
    const range = Math.max(1, Math.floor(workRange || 1));
    for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) {
            const x = targetPos.x + dx;
            const y = targetPos.y + dy;
            if (x < 0 || x > 49 || y < 0 || y > 49) continue;
            if (Math.max(Math.abs(dx), Math.abs(dy)) > range) continue;
            candidates.push({ x, y, roomName: targetPos.roomName || room.name });
        }
    }
    return candidates;
}

function pickClosest(creepPos, candidates) {
    if (!creepPos || !candidates || candidates.length === 0) return null;
    let best = null;
    let bestRange = Infinity;
    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const range = creepPos.getRangeTo(candidate.x, candidate.y);
        if (range < bestRange) {
            bestRange = range;
            best = candidate;
        }
    }
    return best;
}

function getVacateSourceMoveIntent(creep, workKind, workTarget, workRange) {
    if (!creep || !creep.pos || !creep.room || !workTarget || !workTarget.pos) return null;

    const sources = getSources(creep.room);
    if (!sources || sources.length <= 0) return null;

    const forbidRangeFromSource = 1;
    if (!isNearSource(creep.pos, sources, forbidRangeFromSource)) return null;

    if (workKind === 'repair') {
        const role = (creep.memory && creep.memory.role) || '';
        if (
            DEFAULT_ALLOW_ROLES.includes(role) &&
            isSourceInfra(workTarget.structureType, DEFAULT_ALLOWED_INFRA) &&
            isTargetNearSource(workTarget.pos, sources, forbidRangeFromSource)
        ) {
            return null;
        }
    }

    const candidates = getCandidatePositionsAroundTarget(creep.room, workTarget.pos, workRange);
    const valid = [];
    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        if (!isWalkablePos(creep.room, candidate.x, candidate.y)) continue;
        if (isNearSource(new RoomPosition(candidate.x, candidate.y, candidate.roomName), sources, forbidRangeFromSource)) continue;
        if (isOccupied(creep.room, candidate.x, candidate.y, creep.id)) continue;
        valid.push(candidate);
    }

    const best = pickClosest(creep.pos, valid);
    if (best) {
        return {
            type: 'move',
            targetPos: { x: best.x, y: best.y, roomName: best.roomName },
            range: 0
        };
    }

    return null;
}

function getRemoteGatherIntent(creep, mission, homeRoom, homeRoomName, targetPos) {
    const remoteRoomName = (mission.data && mission.data.remoteRoom) || (targetPos && targetPos.roomName);
    const now = Game.time;

    if (creep.memory._remoteEnergy && creep.memory._remoteEnergy.until && creep.memory._remoteEnergy.until < now) {
        delete creep.memory._remoteEnergy;
    }

    const inRemoteRoom = remoteRoomName && creep.room.name === remoteRoomName;
    const memory = creep.memory._remoteEnergy;

    if (inRemoteRoom) {
        if (!(memory && memory.mode === 'home' && memory.until && memory.until >= now)) {
            if (memory && memory.mode === 'remote' && memory.targetId && memory.roomName === creep.room.name &&
                memory.until && memory.until >= now) {
                const stickyTarget = Game.getObjectById(memory.targetId);
                if (stickyTarget) {
                    if (memory.action === 'harvest') {
                        if (
                            creep.getActiveBodyparts(WORK) > 0 &&
                            stickyTarget.energy > 0 &&
                            hasFreeHarvestSpot(creep, stickyTarget)
                        ) {
                            return { type: 'harvest', targetId: stickyTarget.id };
                        }
                    } else if (memory.action === 'withdraw') {
                        if (stickyTarget.store && (stickyTarget.store[RESOURCE_ENERGY] || 0) > 0) {
                            return { type: 'withdraw', targetId: stickyTarget.id, resourceType: RESOURCE_ENERGY };
                        }
                    }
                }
            }

            const tryHarvest = () => {
                if (creep.getActiveBodyparts(WORK) === 0) return null;
                const cache = global.getRoomCache(creep.room);
                const sources = cache.sourcesActive || creep.room.find(FIND_SOURCES_ACTIVE);
                const nearbySources = sources.filter(s =>
                    creep.pos.getRangeTo(s.pos) <= REMOTE_GATHER_RANGE &&
                    hasFreeHarvestSpot(creep, s)
                );
                const source = creep.pos.findClosestByRange(nearbySources);
                if (!source) return null;
                creep.memory._remoteEnergy = {
                    mode: 'remote',
                    action: 'harvest',
                    targetId: source.id,
                    roomName: creep.room.name,
                    until: now + REMOTE_STICKY_TICKS
                };
                return { type: 'harvest', targetId: source.id };
            };

            const tryWithdraw = () => {
                const cache = global.getRoomCache(creep.room);
                const containers = (cache.structuresByType[STRUCTURE_CONTAINER] || []);
                const storages = (cache.structuresByType[STRUCTURE_STORAGE] || []);
                const candidates = containers.concat(storages).filter(c =>
                    (c.store[RESOURCE_ENERGY] || 0) > 0 &&
                    creep.pos.getRangeTo(c.pos) <= REMOTE_GATHER_RANGE
                );
                const target = creep.pos.findClosestByRange(candidates);
                if (!target) return null;
                creep.memory._remoteEnergy = {
                    mode: 'remote',
                    action: 'withdraw',
                    targetId: target.id,
                    roomName: creep.room.name,
                    until: now + REMOTE_STICKY_TICKS
                };
                return { type: 'withdraw', targetId: target.id, resourceType: RESOURCE_ENERGY };
            };

            const prioritizeWithdraw = !!(mission && mission.data && mission.data.prioritizeWithdraw);
            const picked = prioritizeWithdraw ? (tryWithdraw() || tryHarvest()) : (tryHarvest() || tryWithdraw());
            if (picked) return picked;

            creep.memory._remoteEnergy = {
                mode: 'home',
                roomName: homeRoomName,
                until: now + REMOTE_HOME_STICKY_TICKS
            };
        }
    }

    if (homeRoomName && creep.room.name !== homeRoomName) {
        const anchor = homeRoom && homeRoom.storage ? homeRoom.storage.pos
            : (homeRoom && homeRoom.controller ? homeRoom.controller.pos : null);
        const movePos = anchor || { x: 25, y: 25, roomName: homeRoomName };
        return { type: 'move', targetPos: { x: movePos.x, y: movePos.y, roomName: movePos.roomName }, range: 3 };
    }

    const gatherRoom = homeRoom || creep.room;
    const gather = pickHomeGatherIntent(creep, gatherRoom);
    if (gather) return gather;

    if (targetPos && creep.room.name !== targetPos.roomName) {
        return { type: 'move', targetPos: { x: targetPos.x, y: targetPos.y, roomName: targetPos.roomName }, range: 1 };
    }

    return null;
}

function getRemoteBuildIntent(creep, mission, homeRoom, homeRoomName) {
    const targetPos = toRoomPosition(mission.targetPos || (mission.data && mission.data.targetPos));

    updateState(creep);
    const hasEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
    if (creep.memory.taskState === 'working' && !hasEnergy) {
        creep.memory.taskState = 'gathering';
    }

    if (creep.memory.taskState !== 'working') {
        return getRemoteGatherIntent(creep, mission, homeRoom, homeRoomName, targetPos);
    }

    if (creep.memory._remoteEnergy) delete creep.memory._remoteEnergy;

    if (targetPos && creep.room.name !== targetPos.roomName) {
        return { type: 'move', targetPos: { x: targetPos.x, y: targetPos.y, roomName: targetPos.roomName }, range: 1 };
    }

    let target = null;
    if (mission.targetId) {
        target = getCachedObject(creep.room, mission.targetId) || Game.getObjectById(mission.targetId);
    }
    if (!target && targetPos && creep.room.name === targetPos.roomName) {
        const sites = targetPos.lookFor(LOOK_CONSTRUCTION_SITES);
        if (sites && sites.length > 0) target = sites[0];
    }
    if (!target && targetPos && creep.room.name === targetPos.roomName) {
        const roomSites = creep.room.find(FIND_CONSTRUCTION_SITES);
        if (roomSites && roomSites.length > 0) target = creep.pos.findClosestByRange(roomSites);
    }

    if (!target) return null;

    const vacate = getVacateSourceMoveIntent(creep, 'build', target, 3);
    if (vacate) return vacate;

    return { type: 'build', targetId: target.id };
}

const roleRemoteWorker = {
    run: function(creep) {
        if (!creep || !creep.memory) return;

        const missionName = creep.memory.missionName;
        if (!missionName) {
            movement.enableTrafficBlockerOnlyAtCurrentPos(creep);
            roleUniversal.run(creep);
            return;
        }

        const homeRoomName = creep.memory.room || (creep.room && creep.room.name);
        const homeRoom = homeRoomName ? Game.rooms[homeRoomName] : null;
        const mission = getMissionByName(homeRoom, missionName);
        if (!mission) {
            clearRemoteWorkerAssignment(creep);
            movement.enableTrafficBlockerOnlyAtCurrentPos(creep);
            return;
        }

        if (!REMOTE_WORKER_MISSION_TYPES.has(mission.type)) {
            movement.enableTrafficBlockerOnlyAtCurrentPos(creep);
            roleUniversal.run(creep);
            return;
        }

        movement.enableTrafficForBuildWorker(creep);
        delete creep.memory.task;
        const intent = getRemoteBuildIntent(creep, mission, homeRoom, homeRoomName);
        if (!intent) {
            clearRemoteWorkerAssignment(creep);
            movement.enableTrafficBlockerOnlyAtCurrentPos(creep);
            return;
        }
        executeIntent(creep, intent);
    }
};

module.exports = roleRemoteWorker;
