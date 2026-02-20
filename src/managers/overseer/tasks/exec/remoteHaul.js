const helpers = require('managers_overseer_tasks_exec__helpers');

module.exports = function execRemoteHaulTask(ctx) {
    const { creep, mission } = ctx;
    const data = mission.data || {};
    const resourceType = data.resourceType || RESOURCE_ENERGY;
    const pickupPos = helpers.toRoomPosition(data.pickupPos);
    const dropoffPos = helpers.toRoomPosition(data.dropoffPos);
    const pickupMode = data.pickupMode || 'container';
    const pickupRange = Number.isFinite(data.pickupRange) ? data.pickupRange : 1;

    helpers.updateState(creep, resourceType, { requireFull: true });

    if (creep.memory.taskState === 'working') {
        if (dropoffPos && creep.room.name !== dropoffPos.roomName) {
            return { action: 'move', targetPos: { x: dropoffPos.x, y: dropoffPos.y, roomName: dropoffPos.roomName }, range: 1 };
        }

        let target = data.dropoffId ? Game.getObjectById(data.dropoffId) : null;
        if (!target) {
            const cache = global.getRoomCache(creep.room);
            const storage = (cache.myStructuresByType[STRUCTURE_STORAGE] || [])[0];
            if (storage) target = storage;
            if (!target) {
                const spawns = cache.myStructuresByType[STRUCTURE_SPAWN] || [];
                target = creep.pos.findClosestByRange(spawns);
            }
        }

        if (target) {
            if (target.store && target.store.getFreeCapacity(resourceType) === 0) {
                return { action: 'move', targetId: target.id, range: 1 };
            }
            return { action: 'transfer', targetId: target.id, resourceType: resourceType };
        }
        return null;
    }

    if (pickupPos && creep.room.name !== pickupPos.roomName) {
        return { action: 'move', targetPos: { x: pickupPos.x, y: pickupPos.y, roomName: pickupPos.roomName }, range: 1 };
    }

    const pickup = data.pickupId ? Game.getObjectById(data.pickupId) : null;
    if (pickup && pickup.store && (pickup.store[resourceType] || 0) > 0) {
        return { action: 'withdraw', targetId: pickup.id, resourceType: resourceType };
    }

    const cache = global.getRoomCache(creep.room);
    const tombstone = creep.pos.findClosestByRange(cache.tombstones || [], {
        filter: t => t.store && (t.store[resourceType] || 0) > 50
    });
    if (tombstone) return { action: 'withdraw', targetId: tombstone.id, resourceType: resourceType };

    const dropped = creep.pos.findClosestByRange(cache.dropped || [], {
        filter: r => {
            if (r.resourceType !== resourceType || r.amount <= 50) return false;
            if (pickupMode === 'drop' && pickupPos) {
                return r.pos.inRangeTo(pickupPos, pickupRange);
            }
            return true;
        }
    });
    if (dropped) return { action: 'pickup', targetId: dropped.id };

    if (pickupMode === 'drop' && pickupPos) {
        return { action: 'move', targetPos: { x: pickupPos.x, y: pickupPos.y, roomName: pickupPos.roomName }, range: pickupRange };
    }

    return null;
};