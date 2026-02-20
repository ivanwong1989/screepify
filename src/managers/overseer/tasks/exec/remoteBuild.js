const helpers = require('managers_overseer_tasks_exec__helpers');
const execRemoteEnergyGather = require('managers_overseer_tasks_exec_remoteEnergyGather');

module.exports = function execRemoteBuildTask(ctx) {
    const { creep, mission, room } = ctx;
    const targetPos = helpers.toRoomPosition(mission.targetPos || (mission.data && mission.data.targetPos));
    const remoteRoom = (mission.data && mission.data.remoteRoom) || (targetPos && targetPos.roomName);
    const homeRoom = room || (creep.memory && creep.memory.room ? Game.rooms[creep.memory.room] : null);
    const homeRoomName = homeRoom ? homeRoom.name : (creep.memory && creep.memory.room);

    helpers.updateState(creep);
    const hasEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
    if (creep.memory.taskState === 'working' && !hasEnergy) {
        creep.memory.taskState = 'gathering';
    }

    if (creep.memory.taskState === 'working') {
        if (creep.memory._remoteEnergy) delete creep.memory._remoteEnergy;
        if (targetPos && creep.room.name !== targetPos.roomName) {
            return { action: 'move', targetPos: { x: targetPos.x, y: targetPos.y, roomName: targetPos.roomName }, range: 1 };
        }

        let target = null;
        if (mission.targetId) {
            target = helpers.getCachedObject(creep.room, mission.targetId) || Game.getObjectById(mission.targetId);
        }

        if (!target && targetPos && creep.room.name === targetPos.roomName) {
            const sites = targetPos.lookFor(LOOK_CONSTRUCTION_SITES);
            if (sites && sites.length > 0) target = sites[0];
        }

        if (!target && creep.room.name === (targetPos && targetPos.roomName)) {
            const roomSites = creep.room.find(FIND_CONSTRUCTION_SITES);
            if (roomSites.length > 0) target = creep.pos.findClosestByRange(roomSites);
        }

        if (target) return { action: 'build', targetId: target.id };

        delete creep.memory.missionName;
        delete creep.memory.taskState;
        return null;
    }

    return execRemoteEnergyGather({
        creep,
        homeRoom,
        homeRoomName,
        remoteRoomName: remoteRoom,
        targetPos
    });
};