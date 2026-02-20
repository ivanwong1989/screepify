const helpers = require('managers_overseer_tasks_exec__helpers');
const execRemoteEnergyGather = require('managers_overseer_tasks_exec_remoteEnergyGather');
const vacateSource = require('managers_overseer_tasks_exec__policy_vacate_source');

module.exports = function execRemoteRepairTask(ctx) {
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
            return { type: 'move', targetPos: { x: targetPos.x, y: targetPos.y, roomName: targetPos.roomName }, range: 1 };
        }

        let target = null;
        if (mission.targetId) {
            target = helpers.getCachedObject(creep.room, mission.targetId) || Game.getObjectById(mission.targetId);
        }

        if (!target && targetPos && creep.room.name === targetPos.roomName) {
            const structures = targetPos.lookFor(LOOK_STRUCTURES);
            const repairable = structures.find(s =>
                (s.structureType === STRUCTURE_ROAD || s.structureType === STRUCTURE_CONTAINER) &&
                s.hits < s.hitsMax
            );
            if (repairable) target = repairable;
        }

        if (!target && creep.room.name === (targetPos && targetPos.roomName)) {
            const roomTargets = creep.room.find(FIND_STRUCTURES, {
                filter: s => (s.structureType === STRUCTURE_ROAD || s.structureType === STRUCTURE_CONTAINER) &&
                    s.hits < s.hitsMax
            });
            if (roomTargets.length > 0) target = creep.pos.findClosestByRange(roomTargets);
        }

        if (target && target.hits < target.hitsMax) {
            const move = vacateSource.getVacateSourceMoveIntent(
                creep,
                'repair',
                target,
                3,
                {
                    allowRolesNearSource: ['miner', 'staticMiner', 'remoteHarvester', 'remote_miner', 'harvester_remote'],
                    forbidRangeFromSource: 1,
                    useOccupancyCheck: true,
                    allowedSourceInfraTypes: [STRUCTURE_CONTAINER, STRUCTURE_ROAD, STRUCTURE_LINK],
                    requireTargetNearSource: true
                }
            );
            if (move) return move;
            return { type: 'repair', targetId: target.id };
        }

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
