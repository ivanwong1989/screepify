const roleUniversal = require('role_role.universal');
const movement = require('utils_movement');
const remoteUtils = require('managers_overseer_utils_overseer.remote');

function clearAssignment(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.missionName;
    delete creep.memory.task;
    delete creep.memory.taskState;
    delete creep.memory._trafficMove;
}

function getMissionByName(homeRoom, missionName) {
    if (!homeRoom || !missionName) return null;
    if (homeRoom._remoteReserveMissionMapTick !== Game.time || !homeRoom._remoteReserveMissionMap) {
        const map = Object.create(null);
        const missions = Array.isArray(homeRoom._missions) ? homeRoom._missions : [];
        for (let i = 0; i < missions.length; i++) {
            const mission = missions[i];
            if (!mission || !mission.name) continue;
            map[mission.name] = mission;
        }
        homeRoom._remoteReserveMissionMap = map;
        homeRoom._remoteReserveMissionMapTick = Game.time;
    }
    return homeRoom._remoteReserveMissionMap[missionName] || null;
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

function moveToPos(creep, pos, range) {
    if (!creep || !pos) return;
    movement.planMoveTo(creep, pos, {
        range: Number.isFinite(range) ? range : 1,
        maxRooms: (pos.roomName && creep.room && pos.roomName !== creep.room.name) ? 16 : 1
    });
}

function getMyUsername() {
    if (global && typeof global.MY_USERNAME === 'string' && global.MY_USERNAME.length > 0) {
        return global.MY_USERNAME;
    }
    for (const name in Game.spawns) {
        const spawn = Game.spawns[name];
        if (!spawn || !spawn.owner || !spawn.owner.username) continue;
        return spawn.owner.username;
    }
    return null;
}

const roleRemoteReserve = {
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

        if (mission.type !== 'remote_reserve') {
            movement.enableTrafficBlockerOnlyAtCurrentPos(creep);
            roleUniversal.run(creep);
            return;
        }

        movement.enableTrafficForBuildWorker(creep);
        delete creep.memory.task;

        const data = mission.data || {};
        const targetRoom = data.targetRoom || data.remoteRoom || mission.targetRoom || null;
        const controllerPos = toRoomPosition(data.controllerPos);

        if (targetRoom && creep.room.name !== targetRoom) {
            if (controllerPos) moveToPos(creep, controllerPos, 1);
            else moveToPos(creep, new RoomPosition(25, 25, targetRoom), 20);
            return;
        }

        const homeRoomKey = creep.memory && creep.memory.room;
        if (targetRoom && homeRoomKey && creep.room && creep.room.name === targetRoom) {
            remoteUtils.recordRuntimeThreatIntel(homeRoomKey, creep.room);
        }

        let controller = null;
        if (data.controllerId) controller = Game.getObjectById(data.controllerId);
        if (!controller && creep.room && creep.room.controller) controller = creep.room.controller;
        if (!controller) {
            if (controllerPos) moveToPos(creep, controllerPos, 1);
            return;
        }

        const code = creep.reserveController(controller);
        if (code === ERR_NOT_IN_RANGE) {
            moveToPos(creep, controller.pos, 1);
            return;
        }

        if (code === ERR_INVALID_TARGET) {
            const myUser = getMyUsername();
            const reservedByOther = controller.reservation && (!myUser || controller.reservation.username !== myUser);
            if (reservedByOther) {
                const attackCode = creep.attackController(controller);
                if (attackCode === ERR_NOT_IN_RANGE) moveToPos(creep, controller.pos, 1);
            }
        }
    }
};

module.exports = roleRemoteReserve;

