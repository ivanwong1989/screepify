const helpers = require('managers_overseer_tasks_exec__helpers');

module.exports = function execDecongestTask(ctx) {
    const { creep, mission, room } = ctx;
    const roomName = (room && room.name) ? room.name : creep.room.name;
    const hasCargo = (typeof creep.store.getUsedCapacity === 'function')
        ? (creep.store.getUsedCapacity() || 0) > 0
        : Object.keys(creep.store || {}).some(k => (creep.store[k] || 0) > 0);

    const findDumpTarget = (resourceType) => {
        if (!resourceType) return null;

        if (
            creep.room.storage &&
            creep.room.storage.store &&
            typeof creep.room.storage.store.getFreeCapacity === 'function' &&
            creep.room.storage.store.getFreeCapacity(resourceType) > 0
        ) {
            return creep.room.storage;
        }

        const cache = global.getRoomCache ? global.getRoomCache(creep.room) : null;
        const containers = cache && cache.structuresByType
            ? (cache.structuresByType[STRUCTURE_CONTAINER] || [])
            : [];
        const candidates = containers.filter(c =>
            c &&
            c.store &&
            typeof c.store.getFreeCapacity === 'function' &&
            c.store.getFreeCapacity(resourceType) > 0
        );
        if (candidates.length === 0) return null;
        return creep.pos.findClosestByRange(candidates);
    };

    if (hasCargo) {
        for (const resourceType in creep.store) {
            if ((creep.store[resourceType] || 0) <= 0) continue;
            const dumpTarget = findDumpTarget(resourceType);
            if (!dumpTarget) continue;
            return { type: 'transfer', targetId: dumpTarget.id, resourceType: resourceType };
        }
    }

    const slots = (mission && mission.data && Array.isArray(mission.data.slotPositions))
        ? mission.data.slotPositions
        : [];

    if (slots.length > 0) {
        const cacheHost = room || creep.room;
        if (!cacheHost._decongestAssigned || cacheHost._decongestAssignedTick !== Game.time) {
            cacheHost._decongestAssignedTick = Game.time;
            cacheHost._decongestAssigned = Object.create(null);
        }

        const cacheKey = `${mission.name}:${creep.memory.room || roomName}`;
        if (!cacheHost._decongestAssigned[cacheKey]) {
            cacheHost._decongestAssigned[cacheKey] = Object.values(Game.creeps)
                .filter(c =>
                    c &&
                    c.my &&
                    c.memory &&
                    c.memory.missionName === mission.name &&
                    c.memory.room === creep.memory.room
                )
                .sort((a, b) => a.name.localeCompare(b.name));
        }

        const assigned = cacheHost._decongestAssigned[cacheKey];

        const slotIndex = assigned.findIndex(c => c.id === creep.id);
        if (slotIndex >= slots.length || slotIndex === -1) {
            // Over-capacity or orphan assignment: release so this creep can take real work.
            delete creep.memory.missionName;
            delete creep.memory.taskState;
            delete creep.memory.task;
            return null;
        }

        const slot = slots[slotIndex];
        if (!slot || slot.roomName !== roomName) return null;

        if (creep.pos.roomName === slot.roomName && creep.pos.x === slot.x && creep.pos.y === slot.y) {
            // Keep assignment while parked; reassignment logic can pull it when needed.
            return null;
        }

        return {
            type: 'move',
            targetPos: { x: slot.x, y: slot.y, roomName: slot.roomName },
            range: 0
        };
    }

    let targets = [];
    if (mission.targetIds) {
        targets = (mission.targetIds || []).map(id => helpers.getCachedObject(creep.room, id)).filter(t => t);
    } else if (mission.targetNames) {
        targets = (mission.targetNames || []).map(name => Game.flags[name]).filter(t => t);
    }

    if (targets.length > 0) {
        const target = creep.pos.findClosestByRange(targets);
        if (target) {
            if (creep.pos.inRangeTo(target.pos, 1)) return null;
            if (target instanceof Flag) {
                return { type: 'move', targetName: target.name };
            }
            return { type: 'move', targetId: target.id };
        }
    }
    return null;
};
