const helpers = require('managers_overseer_tasks_exec__helpers');

function isValidId(value) {
    return typeof value === 'string' && value.length > 0;
}

function getFirstValidDropoff(room, dropoffIds, resourceType) {
    for (const id of dropoffIds) {
        const target = helpers.getCachedObject(room, id);
        if (!target || !target.store) continue;
        if (target.store.getFreeCapacity(resourceType) > 0) return target;
    }
    return null;
}

function logContractError(creep, reason) {
    console.log(`[harvest] invalid mission contract for ${creep.name}: ${reason}`);
}

function getHarvestSlotIndex(creep) {
    const bindId = creep.memory && creep.memory.bindId;
    if (!bindId) return 0;
    const parts = String(bindId).split(':');
    const last = parts[parts.length - 1];
    const i = Number(last);
    return Number.isFinite(i) ? i : 0;
}

module.exports = function execHarvestTask(ctx) {
    const { creep, mission } = ctx;
    const data = mission && mission.data ? mission.data : null;
    if (!data) {
        logContractError(creep, 'missing data');
        helpers.unassignMission(creep);
        return null;
    }

    const sourceId = data.sourceId;
    const mode = data.mode;
    const dropoffIds = Array.isArray(data.dropoffIds) ? data.dropoffIds : null;
    const fallback = data.fallback || 'none';
    const resourceType = data.resourceType || RESOURCE_ENERGY;
    const dropoffRange = Number.isFinite(data.dropoffRange) ? data.dropoffRange : 1;
    const overflowPolicy = data.overflowPolicy || 'drop';

    if (!isValidId(sourceId)) {
        logContractError(creep, 'missing sourceId');
        helpers.unassignMission(creep);
        return null;
    }
    if (mode !== 'static' && mode !== 'mobile') {
        logContractError(creep, `invalid mode ${mode}`);
        helpers.unassignMission(creep);
        return null;
    }
    if (!dropoffIds || !dropoffIds.every(isValidId)) {
        logContractError(creep, 'invalid dropoffIds');
        helpers.unassignMission(creep);
        return null;
    }
    if (fallback !== 'none' && fallback !== 'upgrade') {
        logContractError(creep, `invalid fallback ${fallback}`);
        helpers.unassignMission(creep);
        return null;
    }
    if (mode === 'static' && (!isValidId(data.containerId) || dropoffIds.length === 0)) {
        logContractError(creep, 'missing containerId for static mode');
        helpers.unassignMission(creep);
        return null;
    }

    const source = helpers.getCachedObject(creep.room, sourceId);
    if (!source) {
        logContractError(creep, 'source not found');
        helpers.unassignMission(creep);
        return null;
    }

    if (mode === 'static') {
        const container = helpers.getCachedObject(creep.room, data.containerId);
        if (!container) {
            logContractError(creep, 'container not found');
            helpers.unassignMission(creep);
            return null;
        }

        const slotIndex = getHarvestSlotIndex(creep);
        const roles = data.staticRolesBySlot || null;
        const role = roles ? roles[String(slotIndex)] : 'container';

        if (role === 'container') {
            if (!creep.pos.isEqualTo(container.pos)) {
                const creepsOnContainer = container.pos.lookFor(LOOK_CREEPS)
                    .filter(c => c.id !== creep.id);
                if (creepsOnContainer.length === 0) {
                    return { type: 'move', targetId: data.containerId, range: 0 };
                }
                return { type: 'move', targetId: data.containerId, range: 1 };
            }

            helpers.updateState(creep, resourceType, { allowPartialWork: true });
            if (creep.memory.taskState === 'working' || creep.store.getFreeCapacity(resourceType) === 0) {
                const transferTarget = getFirstValidDropoff(creep.room, dropoffIds, resourceType);
                if (transferTarget) {
                    return { type: 'transfer', targetId: transferTarget.id, resourceType, range: dropoffRange };
                }
                if (fallback === 'upgrade' && creep.room.controller && creep.room.controller.my) {
                    return { type: 'upgrade', targetId: creep.room.controller.id };
                }
                return { type: 'harvest', targetId: sourceId };
            }

            return { type: 'harvest', targetId: sourceId };
        }

        if (creep.pos.isEqualTo(container.pos)) {
            return { type: 'move', targetId: sourceId, range: 1 };
        }

        if (!creep.pos.inRangeTo(source.pos, 1)) {
            return { type: 'move', targetId: sourceId, range: 1 };
        }

        helpers.updateState(creep, resourceType, { allowPartialWork: true });
        if (creep.memory.taskState === 'working' || creep.store.getFreeCapacity(resourceType) === 0) {
            if (creep.pos.inRangeTo(container.pos, 1) && container.store.getFreeCapacity(resourceType) > 0) {
                return { type: 'transfer', targetId: container.id, resourceType, range: 1 };
            }
            if (overflowPolicy === 'drop') return { type: 'drop', resourceType: resourceType };

            const transferTarget = getFirstValidDropoff(creep.room, dropoffIds, resourceType);
            if (transferTarget) {
                return { type: 'transfer', targetId: transferTarget.id, resourceType, range: dropoffRange };
            }
            if (fallback === 'upgrade' && creep.room.controller && creep.room.controller.my) {
                return { type: 'upgrade', targetId: creep.room.controller.id };
            }
        }

        return { type: 'harvest', targetId: sourceId };
    }

    helpers.updateState(creep, resourceType, { allowPartialWork: true });
    if (creep.memory.taskState !== 'working') {
        return { type: 'harvest', targetId: sourceId };
    }

    const transferTarget = getFirstValidDropoff(creep.room, dropoffIds, resourceType);
    if (transferTarget) {
        return { type: 'transfer', targetId: transferTarget.id, resourceType, range: dropoffRange };
    }
    if (fallback === 'upgrade' && creep.room.controller && creep.room.controller.my) {
        return { type: 'upgrade', targetId: creep.room.controller.id };
    }

    return { type: 'move', targetId: sourceId, range: 1 };
};
