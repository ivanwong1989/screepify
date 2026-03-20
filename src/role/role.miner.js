const borderNav = require('utils_creepBorderNav');
const roleUniversal = require('role_role.universal');
const heap = require('utils_heap');

const MINER_HEAP_STORE = 'roleMiner';

function getRoomCache(room) {
    if (!room || typeof global.getRoomCache !== 'function') return null;
    return global.getRoomCache(room);
}

function getMinerRoomMemo(room, roomCache) {
    if (!room) return null;
    const store = heap.getStore(MINER_HEAP_STORE, { ttl: 50 });
    const existing = store[room.name];
    if (existing && existing.time === Game.time) return existing;

    const occupancy = Object.create(null);
    const creeps = (roomCache && Array.isArray(roomCache.creeps))
        ? roomCache.creeps
        : room.find(FIND_CREEPS);
    for (let i = 0; i < creeps.length; i++) {
        const c = creeps[i];
        if (!c || !c.pos) continue;
        const key = `${c.pos.x}:${c.pos.y}`;
        occupancy[key] = (occupancy[key] || 0) + 1;
    }

    const memo = {
        time: Game.time,
        idObj: Object.create(null),
        slotByBindId: Object.create(null),
        occupancyByTile: occupancy
    };
    store[room.name] = memo;
    return memo;
}

function getObjectByIdCached(memo, id) {
    if (!id) return null;
    if (!memo) return Game.getObjectById(id);
    if (memo.idObj[id] === undefined) memo.idObj[id] = Game.getObjectById(id) || null;
    return memo.idObj[id];
}

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

function getHarvestSlotIndex(creep, memo) {
    const bindId = creep && creep.memory ? creep.memory.bindId : null;
    if (!bindId) return 0;
    if (memo && memo.slotByBindId[bindId] !== undefined) return memo.slotByBindId[bindId];
    const text = String(bindId);
    const splitAt = text.lastIndexOf(':');
    const rawIndex = splitAt >= 0 ? text.substring(splitAt + 1) : text;
    const index = Number(rawIndex);
    const resolved = Number.isFinite(index) ? index : 0;
    if (memo) memo.slotByBindId[bindId] = resolved;
    return resolved;
}

function getTileOccupancy(memo, pos) {
    if (!memo || !pos) return 0;
    return memo.occupancyByTile[`${pos.x}:${pos.y}`] || 0;
}

function isContainerTileFreeForCreep(container, creep, memo) {
    if (!container || !container.pos || !creep || !creep.pos) return true;
    const occupied = getTileOccupancy(memo, container.pos);
    if (occupied <= 0) return true;
    if (creep.pos.isEqualTo(container.pos)) return occupied <= 1;
    return occupied <= 0;
}

function getFirstValidDropoff(dropoffIds, resourceType, memo) {
    if (!Array.isArray(dropoffIds) || dropoffIds.length <= 0) return null;
    for (let i = 0; i < dropoffIds.length; i++) {
        const id = dropoffIds[i];
        if (!id) continue;
        const target = getObjectByIdCached(memo, id);
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

function runStaticContainer(creep, source, container, data, resourceType, memo) {
    if (!creep.pos.isEqualTo(container.pos)) {
        if (isContainerTileFreeForCreep(container, creep, memo)) {
            tryMoveTo(creep, container, 0);
        } else {
            tryMoveTo(creep, container, 1);
        }
        return;
    }

    if ((creep.store[resourceType] || 0) > 0 && isFull(creep, resourceType)) {
        const transferTarget = getFirstValidDropoff(data.dropoffIds, resourceType, memo);
        if (transferTarget) {
            tryTransfer(creep, transferTarget, resourceType, Number.isFinite(data.dropoffRange) ? data.dropoffRange : 1);
            return;
        }

        if (data.fallback === 'upgrade' && tryUpgradeFallback(creep)) return;
    }

    tryHarvest(creep, source);
}

function runStaticOverflow(creep, source, container, data, resourceType, memo) {
    if (creep.pos.isEqualTo(container.pos)) {
        tryMoveTo(creep, source, 1);
        return;
    }

    if (!creep.pos.inRangeTo(source.pos, 1)) {
        tryMoveTo(creep, source, 1);
        return;
    }

    if ((creep.store[resourceType] || 0) > 0 && isFull(creep, resourceType)) {
        const transferTarget = getFirstValidDropoff(data.dropoffIds, resourceType, memo);
        if (transferTarget) {
            tryTransfer(creep, transferTarget, resourceType, Number.isFinite(data.dropoffRange) ? data.dropoffRange : 1);
            return;
        }

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

        if (data.fallback === 'upgrade' && tryUpgradeFallback(creep)) return;
    }

    tryHarvest(creep, source);
}

function runStaticDrop(creep, source, data, resourceType, memo) {
    if (!creep.pos.inRangeTo(source.pos, 1)) {
        tryMoveTo(creep, source, 1);
        return;
    }

    if ((creep.store[resourceType] || 0) > 0 && isFull(creep, resourceType)) {
        const transferTarget = getFirstValidDropoff(data.dropoffIds, resourceType, memo);
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

function runMobile(creep, source, data, resourceType, memo) {
    const carried = creep.store[resourceType] || 0;
    if (carried <= 0) {
        tryHarvest(creep, source);
        return;
    }

    const transferTarget = getFirstValidDropoff(data.dropoffIds, resourceType, memo);
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

function clearTransientTaskMemory(creep) {
    if (!creep || !creep.memory) return;
    if (creep.memory.task !== undefined) delete creep.memory.task;
    if (creep.memory.taskState !== undefined) delete creep.memory.taskState;
}

function getMissionRoleData(mission, memo) {
    const data = mission.data || {};
    const sourceId = data.sourceId || mission.sourceId || mission.targetId;
    const source = sourceId ? getObjectByIdCached(memo, sourceId) : null;
    if (!source) return null;

    const mode = data.mode || 'mobile';
    const resourceType = data.resourceType || RESOURCE_ENERGY;
    const container = data.containerId ? getObjectByIdCached(memo, data.containerId) : null;

    return { data, source, mode, resourceType, container };
}

function runHarvestMode(creep, modeCtx, memo) {
    if (modeCtx.mode === 'static') {
        if (!modeCtx.container) {
            clearMinerAssignment(creep);
            return;
        }

        const slotIndex = getHarvestSlotIndex(creep, memo);
        const staticRoles = modeCtx.data.staticRolesBySlot || {};
        const slotRole = staticRoles[String(slotIndex)] || 'container';
        if (slotRole === 'container') {
            runStaticContainer(creep, modeCtx.source, modeCtx.container, modeCtx.data, modeCtx.resourceType, memo);
            return;
        }
        runStaticOverflow(creep, modeCtx.source, modeCtx.container, modeCtx.data, modeCtx.resourceType, memo);
        return;
    }

    if (modeCtx.mode === 'static_drop') {
        runStaticDrop(creep, modeCtx.source, modeCtx.data, modeCtx.resourceType, memo);
        return;
    }

    runMobile(creep, modeCtx.source, modeCtx.data, modeCtx.resourceType, memo);
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

        clearTransientTaskMemory(creep);
        const roomCache = getRoomCache(creep.room);
        const memo = getMinerRoomMemo(creep.room, roomCache);
        const modeCtx = getMissionRoleData(mission, memo);
        if (!modeCtx) {
            clearMinerAssignment(creep);
            return;
        }

        runHarvestMode(creep, modeCtx, memo);
    }
};

module.exports = roleMiner;
