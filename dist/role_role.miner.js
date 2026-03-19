const borderNav = require('utils_creepBorderNav');
const roleUniversal = require('role_role.universal');

function clearMinerAssignment(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.missionName;
    delete creep.memory.task;
    delete creep.memory.taskState;
    delete creep.memory.minerState;
}

function getMissionByName(homeRoom, missionName) {
    if (!homeRoom || !missionName) return null;
    if (homeRoom._minerMissionMapTick !== Game.time || !homeRoom._minerMissionMap) {
        const map = Object.create(null);
        const missions = Array.isArray(homeRoom._missions) ? homeRoom._missions : [];
        for (let i = 0; i < missions.length; i++) {
            const mission = missions[i];
            if (!mission || !mission.name) continue;
            map[mission.name] = mission;
        }
        homeRoom._minerMissionMap = map;
        homeRoom._minerMissionMapTick = Game.time;
    }
    return homeRoom._minerMissionMap[missionName] || null;
}

function getHarvestSlotIndex(creep) {
    const bindId = creep && creep.memory ? creep.memory.bindId : null;
    if (!bindId) return 0;
    const parts = String(bindId).split(':');
    const index = Number(parts[parts.length - 1]);
    return Number.isFinite(index) ? index : 0;
}

function getFirstValidDropoff(dropoffIds, resourceType) {
    if (!Array.isArray(dropoffIds) || dropoffIds.length <= 0) return null;
    for (let i = 0; i < dropoffIds.length; i++) {
        const id = dropoffIds[i];
        if (!id) continue;
        const target = Game.getObjectById(id);
        if (!target || !target.store) continue;
        if ((target.store.getFreeCapacity(resourceType) || 0) > 0) return target;
    }
    return null;
}

function tryMoveTo(creep, target, range) {
    if (!creep || !target) return;
    const desiredRange = Number.isFinite(range) ? range : 1;
    borderNav.moveToTarget(creep, target, desiredRange);
}

function tryHarvest(creep, source) {
    if (!creep || !source) return;
    const result = creep.harvest(source);
    if (result === ERR_NOT_IN_RANGE) {
        tryMoveTo(creep, source, 1);
    }
}

function tryTransfer(creep, target, resourceType, range) {
    if (!creep || !target) return false;
    const code = creep.transfer(target, resourceType);
    if (code === ERR_NOT_IN_RANGE) {
        tryMoveTo(creep, target, range);
        return true;
    }
    return code === OK;
}

function tryUpgradeFallback(creep) {
    if (!creep || !creep.room || !creep.room.controller || !creep.room.controller.my) return false;
    const code = creep.upgradeController(creep.room.controller);
    if (code === ERR_NOT_IN_RANGE) {
        tryMoveTo(creep, creep.room.controller, 3);
        return true;
    }
    return code === OK;
}

function isFull(creep, resourceType) {
    if (!creep || !creep.store) return false;
    return (creep.store.getFreeCapacity(resourceType) || 0) <= 0;
}

function runStaticContainer(creep, source, container, data, resourceType) {
    if (!creep.pos.isEqualTo(container.pos)) {
        const creepsOnContainer = container.pos.lookFor(LOOK_CREEPS).filter(c => c && c.id !== creep.id);
        if (creepsOnContainer.length === 0) {
            tryMoveTo(creep, container, 0);
        } else {
            tryMoveTo(creep, container, 1);
        }
        return;
    }

    if ((creep.store[resourceType] || 0) > 0 && isFull(creep, resourceType)) {
        const transferTarget = getFirstValidDropoff(data.dropoffIds, resourceType);
        if (transferTarget) {
            tryTransfer(creep, transferTarget, resourceType, Number.isFinite(data.dropoffRange) ? data.dropoffRange : 1);
            return;
        }

        if (data.fallback === 'upgrade' && tryUpgradeFallback(creep)) return;
    }

    tryHarvest(creep, source);
}

function runStaticOverflow(creep, source, container, data, resourceType) {
    if (creep.pos.isEqualTo(container.pos)) {
        tryMoveTo(creep, source, 1);
        return;
    }

    if (!creep.pos.inRangeTo(source.pos, 1)) {
        tryMoveTo(creep, source, 1);
        return;
    }

    if ((creep.store[resourceType] || 0) > 0 && isFull(creep, resourceType)) {
        if (
            creep.pos.inRangeTo(container.pos, 1) &&
            container.store &&
            (container.store.getFreeCapacity(resourceType) || 0) > 0
        ) {
            tryTransfer(creep, container, resourceType, 1);
            return;
        }

        if (data.overflowPolicy === 'drop') {
            creep.drop(resourceType);
            return;
        }

        const transferTarget = getFirstValidDropoff(data.dropoffIds, resourceType);
        if (transferTarget) {
            tryTransfer(creep, transferTarget, resourceType, Number.isFinite(data.dropoffRange) ? data.dropoffRange : 1);
            return;
        }

        if (data.fallback === 'upgrade' && tryUpgradeFallback(creep)) return;
    }

    tryHarvest(creep, source);
}

function runStaticDrop(creep, source, data, resourceType) {
    if (!creep.pos.inRangeTo(source.pos, 1)) {
        tryMoveTo(creep, source, 1);
        return;
    }

    if ((creep.store[resourceType] || 0) > 0 && isFull(creep, resourceType)) {
        const transferTarget = getFirstValidDropoff(data.dropoffIds, resourceType);
        if (transferTarget) {
            tryTransfer(creep, transferTarget, resourceType, Number.isFinite(data.dropoffRange) ? data.dropoffRange : 1);
            return;
        }

        if (data.overflowPolicy === 'drop') {
            creep.drop(resourceType);
            return;
        }

        if (data.fallback === 'upgrade' && tryUpgradeFallback(creep)) return;
    }

    tryHarvest(creep, source);
}

function runMobile(creep, source, data, resourceType) {
    const carried = creep.store[resourceType] || 0;
    if (carried <= 0) {
        tryHarvest(creep, source);
        return;
    }

    const transferTarget = getFirstValidDropoff(data.dropoffIds, resourceType);
    if (!transferTarget && data.fallback === 'upgrade' && tryUpgradeFallback(creep)) return;

    const sourceDepleted = Number.isFinite(source.energy) && source.energy <= 0;
    if (!isFull(creep, resourceType) && !sourceDepleted) {
        tryHarvest(creep, source);
        return;
    }

    if (transferTarget) {
        tryTransfer(creep, transferTarget, resourceType, Number.isFinite(data.dropoffRange) ? data.dropoffRange : 1);
        return;
    }

    if (data.fallback === 'upgrade' && tryUpgradeFallback(creep)) return;
    tryMoveTo(creep, source, 1);
}

const roleMiner = {
    run: function(creep) {
        if (!creep || !creep.memory) return;

        if (creep.memory._travellingToHome) {
            roleUniversal.run(creep);
            return;
        }

        const missionName = creep.memory.missionName;
        if (!missionName) {
            roleUniversal.run(creep);
            return;
        }

        const homeRoomName = creep.memory.room || (creep.room && creep.room.name);
        const homeRoom = homeRoomName ? Game.rooms[homeRoomName] : null;
        const mission = getMissionByName(homeRoom, missionName);
        if (!mission) {
            clearMinerAssignment(creep);
            return;
        }

        if (mission.type !== 'harvest') {
            roleUniversal.run(creep);
            return;
        }

        delete creep.memory.task;
        delete creep.memory.taskState;

        const data = mission.data || {};
        const sourceId = data.sourceId || mission.sourceId || mission.targetId;
        const source = sourceId ? Game.getObjectById(sourceId) : null;
        if (!source) {
            clearMinerAssignment(creep);
            return;
        }

        const resourceType = data.resourceType || RESOURCE_ENERGY;
        const mode = data.mode || 'mobile';
        if (mode === 'static') {
            const container = data.containerId ? Game.getObjectById(data.containerId) : null;
            if (!container) {
                clearMinerAssignment(creep);
                return;
            }

            const slotIndex = getHarvestSlotIndex(creep);
            const staticRoles = data.staticRolesBySlot || {};
            const slotRole = staticRoles[String(slotIndex)] || 'container';
            if (slotRole === 'container') {
                runStaticContainer(creep, source, container, data, resourceType);
                return;
            }
            runStaticOverflow(creep, source, container, data, resourceType);
            return;
        }

        if (mode === 'static_drop') {
            runStaticDrop(creep, source, data, resourceType);
            return;
        }

        runMobile(creep, source, data, resourceType);
    }
};

module.exports = roleMiner;
