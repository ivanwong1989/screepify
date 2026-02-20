const helpers = require('managers_overseer_tasks_exec__helpers');

module.exports = function execClaimTask(ctx) {
    const { creep, mission } = ctx;
    const data = mission.data || {};
    const targetRoom = data.targetRoom || (mission.targetPos && mission.targetPos.roomName) || (data.targetPos && data.targetPos.roomName);

    if (!targetRoom) {
        delete creep.memory.missionName;
        delete creep.memory.taskState;
        return null;
    }

    if (creep.room.name !== targetRoom) {
        const movePos = helpers.toRoomPosition(data.targetPos || mission.targetPos) || new RoomPosition(25, 25, targetRoom);
        return {
            action: 'move',
            targetPos: { x: movePos.x, y: movePos.y, roomName: movePos.roomName },
            range: 1
        };
    }

    const controller = creep.room.controller;
    if (!controller) {
        delete creep.memory.missionName;
        delete creep.memory.taskState;
        return null;
    }

    if (controller.my) {
        delete creep.memory.missionName;
        delete creep.memory.taskState;
        return null;
    }

    if (controller.owner) {
        if (data.persist !== true) {
            delete creep.memory.missionName;
            delete creep.memory.taskState;
        }
        return null;
    }

    return { action: 'claim', targetId: controller.id, range: 1 };
};