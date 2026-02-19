'use strict';

module.exports = function resolveEnergySink(creep, mission, room, deps) {
    const resourceType = (mission.data && mission.data.resourceType) ? mission.data.resourceType : RESOURCE_ENERGY;
    let target = null;
    
    if (resourceType === RESOURCE_ENERGY &&
        mission.targetType === 'transfer_list' &&
        mission.data &&
        mission.data.targetIds) {
        const targets = mission.data.targetIds
            .map(id => deps.getCachedObject(creep.room, id))
            .filter(t => t && t.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
        target = creep.pos.findClosestByRange(targets);
    }

    if (!target && mission.targetId) {
        target = deps.getCachedObject(creep.room, mission.targetId);
    }

    return target;
};
