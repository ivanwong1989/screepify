const helpers = require('managers_overseer_tasks_exec__helpers');

module.exports = function execMineralTask(ctx) {
    const { creep, mission, room } = ctx;
    const mineral = mission.mineralId ? helpers.getCachedObject(creep.room, mission.mineralId) : null;
    if (!mineral || mineral.mineralAmount <= 0) {
        delete creep.memory.missionName;
        delete creep.memory.taskState;
        return null;
    }

    if (mission.data && mission.data.extractorId) {
        const extractor = helpers.getCachedObject(creep.room, mission.data.extractorId);
        if (!extractor) {
            delete creep.memory.missionName;
            delete creep.memory.taskState;
            return null;
        }
    }

    const resourceType = (mission.data && mission.data.resourceType) ? mission.data.resourceType : mineral.mineralType;
    const container = (mission.data && mission.data.containerId)
        ? helpers.getCachedObject(creep.room, mission.data.containerId)
        : null;
    const terminal = room && room.terminal ? room.terminal : null;
    const storage = room && room.storage ? room.storage : null;

    const carriedTypes = Object.keys(creep.store).filter(r => creep.store[r] > 0);
    if (carriedTypes.length > 0) {
        const depositType = carriedTypes.includes(resourceType) ? resourceType : carriedTypes[0];
        const terminalHasSpace = terminal && terminal.store.getFreeCapacity(depositType) > 0;
        const storageHasSpace = storage && storage.store.getFreeCapacity(depositType) > 0;
        const containerHasSpace = container && container.store.getFreeCapacity(depositType) > 0;
        const depositTarget = terminalHasSpace ? terminal : (storageHasSpace ? storage : (containerHasSpace ? container : null));

        if (depositTarget === container && creep.pos.inRangeTo(container.pos, 1)) {
            return { action: 'transfer', targetId: container.id, resourceType: depositType };
        }

        if (creep.store.getFreeCapacity() === 0) {
            if (depositTarget) {
                if (depositTarget === container) {
                    if (creep.pos.inRangeTo(container.pos, 1)) {
                        return { action: 'transfer', targetId: container.id, resourceType: depositType };
                    }
                    return { action: 'move', targetId: container.id, range: 0 };
                }
                return { action: 'transfer', targetId: depositTarget.id, resourceType: depositType };
            }
            return { action: 'drop', resourceType: depositType };
        }
    }

    if (container && !creep.pos.isEqualTo(container.pos)) {
        const creepsOnContainer = container.pos.lookFor(LOOK_CREEPS);
        if (creepsOnContainer.length === 0) {
            return { action: 'move', targetId: container.id, range: 0 };
        }
    }

    return { action: 'harvest', targetId: mineral.id };
};