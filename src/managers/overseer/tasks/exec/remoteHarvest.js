const helpers = require('managers_overseer_tasks_exec__helpers');

module.exports = function execRemoteHarvestTask(ctx) {
    const { creep, mission } = ctx;
    const data = mission.data || {};

    const sourcePos = helpers.toRoomPosition(data.sourcePos || mission.pos);
    const remoteRoom = data.remoteRoom || (sourcePos && sourcePos.roomName);
    const containerPos = helpers.toRoomPosition(data.containerPos);
    const standPos = helpers.toRoomPosition(data.standPos);

    // 1) Travel to remote
    if (remoteRoom && creep.room.name !== remoteRoom) {
        if (sourcePos) {
            return { type: 'move', targetPos: { x: sourcePos.x, y: sourcePos.y, roomName: sourcePos.roomName }, range: 1 };
        }
        return { type: 'move', targetPos: { x: 25, y: 25, roomName: remoteRoom }, range: 20 };
    }

    const container = data.containerId ? Game.getObjectById(data.containerId) : null;

    // 2) Container usage rules:
    // - Drop mining must ALWAYS be allowed.
    // - If container doesn't exist OR is full, we drop.
    // - Only "use container" when it exists and has free capacity.
    const canUseContainer = !!(container && container.store && container.store.getFreeCapacity(RESOURCE_ENERGY) > 0);

    // "dropMode" is true whenever we cannot successfully transfer into the container.
    // This prevents deadlocks when container is destroyed but containerPos exists, or when container is full.
    const dropMode = !canUseContainer;

    // 3) Positioning:
    // Prefer standing on the container tile if the container exists; otherwise use containerPos (if known).
    if (container && !creep.pos.isEqualTo(container.pos)) {
        const creepsOnContainer = container.pos.lookFor(LOOK_CREEPS);
        if (creepsOnContainer.length === 0 || (creepsOnContainer.length === 1 && creepsOnContainer[0].id === creep.id)) {
            return { type: 'move', targetPos: { x: container.pos.x, y: container.pos.y, roomName: container.pos.roomName }, range: 0 };
        }
    } else if (!container && containerPos && !creep.pos.isEqualTo(containerPos)) {
        // Container missing/destroyed: still allow standing on the remembered tile (good for rebuilding later).
        return { type: 'move', targetPos: { x: containerPos.x, y: containerPos.y, roomName: containerPos.roomName }, range: 0 };
    } else if (!container && standPos && !creep.pos.isEqualTo(standPos)) {
        // Drop mining: keep miner on deterministic stand tile so hauler lanes can anchor to it.
        return { type: 'move', targetPos: { x: standPos.x, y: standPos.y, roomName: standPos.roomName }, range: 0 };
    }

    // 4) State machine (working/gathering) from your helpers
    helpers.updateState(creep);

    // 5) Working behavior:
    // If creep has CARRY, it can meaningfully transfer/drop.
    if (creep.memory.taskState === 'working' && creep.getActiveBodyparts(CARRY) > 0) {
        if (container && creep.pos.inRangeTo(container.pos, 1) && canUseContainer) {
            return { type: 'transfer', targetId: container.id, resourceType: RESOURCE_ENERGY };
        }

        // If container missing OR full, always drop (never stall)
        if (dropMode) {
            return { type: 'drop', resourceType: RESOURCE_ENERGY };
        }
    }

    // 6) Harvest fallback: always harvest if possible.
    const source = mission.sourceId ? Game.getObjectById(mission.sourceId) : null;
    if (source) return { type: 'harvest', targetId: source.id };

    // If source object not found (no vision edge case), move to known pos
    if (sourcePos) return { type: 'move', targetPos: { x: sourcePos.x, y: sourcePos.y, roomName: sourcePos.roomName }, range: 1 };

    return null;
};
