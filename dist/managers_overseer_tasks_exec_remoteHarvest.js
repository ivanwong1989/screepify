const helpers = require('managers_overseer_tasks_exec__helpers');

module.exports = function execRemoteHarvestTask(ctx) {
    const { creep, mission } = ctx;
    const data = mission.data || {};
    const sourcePos = helpers.toRoomPosition(data.sourcePos || mission.pos);
    const remoteRoom = data.remoteRoom || (sourcePos && sourcePos.roomName);
    const containerPos = helpers.toRoomPosition(data.containerPos);

    if (remoteRoom && creep.room.name !== remoteRoom) {
        if (sourcePos) {
            return { action: 'move', targetPos: { x: sourcePos.x, y: sourcePos.y, roomName: sourcePos.roomName }, range: 1 };
        }
        return { action: 'move', targetPos: { x: 25, y: 25, roomName: remoteRoom }, range: 20 };
    }

    const container = data.containerId ? Game.getObjectById(data.containerId) : null;
    const dropMode = data.mode === 'drop' || (!container && !containerPos);
    if (container && !creep.pos.isEqualTo(container.pos)) {
        const creepsOnContainer = container.pos.lookFor(LOOK_CREEPS);
        if (creepsOnContainer.length === 0 || (creepsOnContainer.length === 1 && creepsOnContainer[0].id === creep.id)) {
            return { action: 'move', targetPos: { x: container.pos.x, y: container.pos.y, roomName: container.pos.roomName }, range: 0 };
        }
    } else if (!container && containerPos && !creep.pos.isEqualTo(containerPos)) {
        return { action: 'move', targetPos: { x: containerPos.x, y: containerPos.y, roomName: containerPos.roomName }, range: 0 };
    }

    helpers.updateState(creep);
    if (creep.memory.taskState === 'working' && creep.getActiveBodyparts(CARRY) > 0) {
        if (container && creep.pos.inRangeTo(container.pos, 1) && container.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            return { action: 'transfer', targetId: container.id, resourceType: RESOURCE_ENERGY };
        }
        if (dropMode) {
            return { action: 'drop', resourceType: RESOURCE_ENERGY };
        }
    }

    const source = mission.sourceId ? Game.getObjectById(mission.sourceId) : null;
    if (source) return { action: 'harvest', targetId: source.id };
    if (sourcePos) return { action: 'move', targetPos: { x: sourcePos.x, y: sourcePos.y, roomName: sourcePos.roomName }, range: 1 };
    return null;
};