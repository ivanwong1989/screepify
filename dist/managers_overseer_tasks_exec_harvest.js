const helpers = require('managers_overseer_tasks_exec__helpers');

module.exports = function execHarvestTask(ctx) {
    const { creep, mission } = ctx;
    const cache = global.getRoomCache(creep.room);

    if (mission.data && mission.data.containerId) {
        const container = helpers.getCachedObject(creep.room, mission.data.containerId);
        if (container && !creep.pos.isEqualTo(container.pos)) {
            const creepsOnContainer = container.pos.lookFor(LOOK_CREEPS);
            if (creepsOnContainer.length === 0) {
                return { action: 'move', targetId: mission.data.containerId, range: 0 };
            }
        }
    }

    helpers.updateState(creep);
    if (creep.memory.taskState === 'working' && creep.getActiveBodyparts(CARRY) > 0) {
        const nearbyContainers = (cache.structuresByType[STRUCTURE_CONTAINER] || [])
            .filter(s => creep.pos.inRangeTo(s.pos, 1));
        const nearbyLinks = (cache.structuresByType[STRUCTURE_LINK] || [])
            .filter(s => creep.pos.inRangeTo(s.pos, 1));
        const nearby = nearbyContainers.concat(nearbyLinks);

        const linkTarget = nearbyLinks.find(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
        const containerTarget = nearbyContainers.find(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
        const transferTarget = linkTarget || containerTarget;

        if (transferTarget) {
            return { action: 'transfer', targetId: transferTarget.id, resourceType: RESOURCE_ENERGY };
        }

        const isStatic = (mission.data && mission.data.mode === 'static') ||
            (nearby.length > 0 && (!mission.data || mission.data.mode !== 'mobile'));

        if (!isStatic) {
            const primaryTargets = [
                ...(cache.myStructuresByType[STRUCTURE_SPAWN] || []),
                ...(cache.myStructuresByType[STRUCTURE_EXTENSION] || [])
            ].filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
            let deliveryTarget = creep.pos.findClosestByRange(primaryTargets);

            if (!deliveryTarget) {
                const secondaryTargets = [
                    ...(cache.myStructuresByType[STRUCTURE_TOWER] || []).filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 50),
                    ...(cache.myStructuresByType[STRUCTURE_STORAGE] || []).filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0)
                ];
                deliveryTarget = creep.pos.findClosestByRange(secondaryTargets);
            }

            if (deliveryTarget) {
                return { action: 'transfer', targetId: deliveryTarget.id, resourceType: RESOURCE_ENERGY };
            }

            if (creep.room.controller && creep.room.controller.my) {
                return { action: 'upgrade', targetId: creep.room.controller.id };
            }

            return null;
        }
    }

    return { action: 'harvest', targetId: mission.sourceId };
};