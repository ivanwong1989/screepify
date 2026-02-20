const helpers = require('managers_overseer_tasks_exec__helpers');

module.exports = function execDismantleTask(ctx) {
    const { creep, mission } = ctx;
    const data = mission.data || {};
    const flagName = data.flagName;
    const flag = flagName ? Game.flags[flagName] : null;
    const targetPosData = data.targetPos;

    if (mission.targetId) {
        const target = helpers.getCachedObject(creep.room, mission.targetId) || Game.getObjectById(mission.targetId);
        if (target) {
            return { type: 'dismantle', targetId: target.id };
        }
    }

    if (flag) {
        const targetPos = flag.pos;
        if (creep.room.name !== targetPos.roomName) {
            return {
                type: 'move',
                targetPos: { x: targetPos.x, y: targetPos.y, roomName: targetPos.roomName },
                range: 1
            };
        }

        const structures = targetPos.lookFor(LOOK_STRUCTURES);
        if (structures && structures.length > 0) {
            return { type: 'dismantle', targetId: structures[0].id };
        }

        if (!flag.memory || flag.memory.persist !== true) {
            flag.remove();
        }
    }

    const fallbackPos = helpers.toRoomPosition(targetPosData);
    if (fallbackPos) {
        if (creep.room.name !== fallbackPos.roomName) {
            return {
                type: 'move',
                targetPos: { x: fallbackPos.x, y: fallbackPos.y, roomName: fallbackPos.roomName },
                range: 1
            };
        }

        const structures = fallbackPos.lookFor(LOOK_STRUCTURES);
        if (structures && structures.length > 0) {
            return { type: 'dismantle', targetId: structures[0].id };
        }
    }

    delete creep.memory.missionName;
    delete creep.memory.taskState;
    return null;
};
