const roleUniversal = require('role_role.universal');
const remoteUtils = require('managers_overseer_utils_overseer.remote');
const movement = require('utils_movement');

function clearAssignment(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.missionName;
    delete creep.memory.task;
    delete creep.memory.taskState;
    delete creep.memory._trafficMove;
}

function getMissionByName(homeRoom, missionName) {
    if (!homeRoom || !missionName) return null;
    if (homeRoom._remoteHarvestMissionMapTick !== Game.time || !homeRoom._remoteHarvestMissionMap) {
        const map = Object.create(null);
        const missions = Array.isArray(homeRoom._missions) ? homeRoom._missions : [];
        for (let i = 0; i < missions.length; i++) {
            const mission = missions[i];
            if (!mission || !mission.name) continue;
            map[mission.name] = mission;
        }
        homeRoom._remoteHarvestMissionMap = map;
        homeRoom._remoteHarvestMissionMapTick = Game.time;
    }
    return homeRoom._remoteHarvestMissionMap[missionName] || null;
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

function updateTaskState(creep, resourceType) {
    const type = resourceType || RESOURCE_ENERGY;
    const used = creep.store.getUsedCapacity(type);
    const free = creep.store.getFreeCapacity(type);

    if (creep.memory.taskState === 'working' && used === 0) creep.memory.taskState = 'idle';
    if (creep.memory.taskState === 'gathering' && free === 0) creep.memory.taskState = 'idle';

    if (creep.memory.taskState === 'idle' || creep.memory.taskState === 'init' || !creep.memory.taskState) {
        creep.memory.taskState = used > 0 ? 'working' : 'gathering';
    }
}

function moveToPos(creep, pos, range) {
    if (!creep || !pos) return;
    movement.planMoveTo(creep, pos, {
        range: Number.isFinite(range) ? range : 1,
        maxRooms: (pos.roomName && creep.room && pos.roomName !== creep.room.name) ? 16 : 1
    });
}

const roleRemoteHarvest = {
    run: function(creep) {
        if (!creep || !creep.memory) return;

        if (creep.memory._travellingToHome) {
            roleUniversal.run(creep);
            return;
        }

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
            clearAssignment(creep);
            movement.enableTrafficBlockerOnlyAtCurrentPos(creep);
            return;
        }

        if (mission.type !== 'remote_harvest') {
            movement.enableTrafficBlockerOnlyAtCurrentPos(creep);
            roleUniversal.run(creep);
            return;
        }

        movement.enableTrafficForBuildWorker(creep);
        delete creep.memory.task;

        const data = mission.data || {};
        const sourcePos = toRoomPosition(data.sourcePos || mission.pos);
        const remoteRoom = data.remoteRoom || (sourcePos && sourcePos.roomName) || mission.targetRoom || null;
        const containerPos = toRoomPosition(data.containerPos);
        const standPos = toRoomPosition(data.standPos);

        if (remoteRoom && creep.room.name !== remoteRoom) {
            if (sourcePos) {
                moveToPos(creep, sourcePos, 1);
            } else {
                moveToPos(creep, new RoomPosition(25, 25, remoteRoom), 20);
            }
            return;
        }

        const homeRoomKey = creep.memory && creep.memory.room;
        if (remoteRoom && homeRoomKey && creep.room && creep.room.name === remoteRoom) {
            remoteUtils.recordRuntimeThreatIntel(homeRoomKey, creep.room);
        }

        const container = data.containerId ? Game.getObjectById(data.containerId) : null;
        const canUseContainer = !!(container && container.store && container.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
        const dropMode = !canUseContainer;

        if (container && !creep.pos.isEqualTo(container.pos)) {
            const creepsOnContainer = container.pos.lookFor(LOOK_CREEPS) || [];
            if (creepsOnContainer.length === 0 || (creepsOnContainer.length === 1 && creepsOnContainer[0].id === creep.id)) {
                moveToPos(creep, container.pos, 0);
                return;
            }
        } else if (!container && containerPos && !creep.pos.isEqualTo(containerPos)) {
            moveToPos(creep, containerPos, 0);
            return;
        } else if (!container && standPos && !creep.pos.isEqualTo(standPos)) {
            moveToPos(creep, standPos, 0);
            return;
        }

        updateTaskState(creep, RESOURCE_ENERGY);

        if (creep.memory.taskState === 'working' && creep.getActiveBodyparts(CARRY) > 0) {
            if (container && canUseContainer) {
                const transferCode = creep.transfer(container, RESOURCE_ENERGY);
                if (transferCode === ERR_NOT_IN_RANGE) {
                    moveToPos(creep, container.pos, 1);
                }
                return;
            }
            if (dropMode) {
                creep.drop(RESOURCE_ENERGY);
                return;
            }
        }

        const sourceId = mission.sourceId || mission.targetId || data.sourceId || null;
        const source = sourceId ? Game.getObjectById(sourceId) : null;
        if (source) {
            const harvestCode = creep.harvest(source);
            if (harvestCode === ERR_NOT_IN_RANGE) moveToPos(creep, source.pos, 1);
            return;
        }

        if (sourcePos) moveToPos(creep, sourcePos, 1);
    }
};

module.exports = roleRemoteHarvest;
