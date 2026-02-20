const helpers = require('managers_overseer_tasks_exec__helpers');
const execGatherTask = require('managers_overseer_tasks_exec_gather');

module.exports = function execTransferTask(ctx) {
    const { creep, mission, room } = ctx;
    const resourceType = (mission.data && mission.data.resourceType) ? mission.data.resourceType : RESOURCE_ENERGY;
    const isSupply = !!(mission.data && mission.data.mode === 'supply');
    const EMPTY_SOURCE_TIMEOUT = 20;
    const previousState = creep.memory.taskState;

    helpers.updateState(creep, resourceType, { requireFull: true, allowPartialWork: isSupply });

    if (!isSupply && previousState === 'working' && creep.memory.taskState === 'gathering') {
        delete creep.memory.missionName;
        delete creep.memory.taskState;
        return null;
    }

    if (creep.memory.taskState === 'working') {
        if (creep.memory._emptySourceTicks) delete creep.memory._emptySourceTicks;
        let target = null;

        if (resourceType === RESOURCE_ENERGY &&
            mission.targetType === 'transfer_list' &&
            mission.data &&
            mission.data.targetIds) {
            const targets = mission.data.targetIds
                .map(id => helpers.getCachedObject(creep.room, id))
                .filter(t => t && t.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
            target = creep.pos.findClosestByRange(targets);
        }

        if (!target && mission.targetId) {
            target = helpers.getCachedObject(creep.room, mission.targetId);
        }

        if (target) {
            if (target.store && target.store.getFreeCapacity(resourceType) === 0) {
                delete creep.memory.missionName;
                delete creep.memory.taskState;
                return null;
            }
            return { action: 'transfer', targetId: target.id, resourceType: resourceType };
        }

        if (resourceType !== RESOURCE_ENERGY) {
            delete creep.memory.missionName;
            delete creep.memory.taskState;
            return null;
        }

        delete creep.memory.missionName;
        delete creep.memory.taskState;
        return null;
    }

    if (resourceType !== RESOURCE_ENERGY && mission.data && mission.data.sourceId) {
        const source = helpers.getCachedObject(creep.room, mission.data.sourceId);
        if (source && source.store && (source.store[resourceType] || 0) > 0) {
            if (creep.memory._emptySourceTicks) delete creep.memory._emptySourceTicks;
            return { action: 'withdraw', targetId: source.id, resourceType: resourceType };
        }
        delete creep.memory.missionName;
        delete creep.memory.taskState;
        return null;
    }

    let task = null;
    if (mission.data && mission.data.sourceId) {
        task = execGatherTask({ creep, room, options: { allowedIds: [mission.data.sourceId] } });
    } else {
        const allowedIds = (mission.data && mission.data.sourceIds) ? mission.data.sourceIds : null;
        const excludeIds = (mission.data && mission.data.targetIds) ? mission.data.targetIds : null;
        task = execGatherTask({ creep, room, options: { allowedIds, excludeIds, preferNearestAvailable: isSupply } });
    }

    if (task) {
        if (creep.memory._emptySourceTicks) delete creep.memory._emptySourceTicks;
        return task;
    }

    if (creep.store.getUsedCapacity(resourceType) > 0) {
        creep.memory.taskState = 'working';
        return execTransferTask(ctx);
    }

    if (resourceType === RESOURCE_ENERGY && mission.data && mission.data.sourceId) {
        const source = helpers.getCachedObject(creep.room, mission.data.sourceId);
        const ticks = (creep.memory._emptySourceTicks || 0) + 1;
        creep.memory._emptySourceTicks = ticks;

        if (ticks < EMPTY_SOURCE_TIMEOUT) {
            if (source) {
                return { action: 'move', targetId: source.id, range: 1 };
            }
            return null;
        }

        delete creep.memory._emptySourceTicks;
    }

    delete creep.memory.missionName;
    delete creep.memory.taskState;
    return null;
};