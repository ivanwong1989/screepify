const movement = require('utils_movement');
const roleUniversal = require('role_role.universal');
const heap = require('utils_heap');

const SIMPLE_HARVEST_HEAP_STORE = 'roleSimpleHarvest';

function getSimpleHarvestRoomMemo(room) {
    if (!room) return null;
    const store = heap.getStore(SIMPLE_HARVEST_HEAP_STORE, { ttl: 50 });
    const existing = store[room.name];
    if (existing && existing.time === Game.time) return existing;
    const memo = {
        time: Game.time,
        idObj: Object.create(null)
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

function clearAssignment(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.missionName;
    delete creep.memory.task;
    delete creep.memory.taskState;
    delete creep.memory.minerState;
    delete creep.memory._trafficMove;
}

function getMissionByName(homeRoom, missionName) {
    if (!homeRoom || !missionName) return null;
    if (homeRoom._simpleHarvestMissionMapTick !== Game.time || !homeRoom._simpleHarvestMissionMap) {
        const map = Object.create(null);
        const missions = Array.isArray(homeRoom._missions) ? homeRoom._missions : [];
        for (let i = 0; i < missions.length; i++) {
            const mission = missions[i];
            if (!mission || !mission.name) continue;
            map[mission.name] = mission;
        }
        homeRoom._simpleHarvestMissionMap = map;
        homeRoom._simpleHarvestMissionMapTick = Game.time;
    }
    return homeRoom._simpleHarvestMissionMap[missionName] || null;
}

function getFirstValidDropoff(dropoffIds, resourceType, memo) {
    if (!Array.isArray(dropoffIds) || dropoffIds.length <= 0) return null;
    for (let i = 0; i < dropoffIds.length; i++) {
        const target = getObjectByIdCached(memo, dropoffIds[i]);
        if (!target || !target.store) continue;
        if ((target.store.getFreeCapacity(resourceType) || 0) > 0) return target;
    }
    return null;
}

function moveToTarget(creep, target, range) {
    if (!creep || !target) return;
    const targetPos = target.pos || target;
    const targetRoomName = targetPos && targetPos.roomName ? targetPos.roomName : null;
    movement.planMoveTo(creep, target, {
        range: Number.isFinite(range) ? range : 1,
        maxRooms: (targetRoomName && creep.room && targetRoomName !== creep.room.name) ? 16 : 1
    });
}

function tryUpgradeFallback(creep) {
    if (!creep || !creep.room || !creep.room.controller || !creep.room.controller.my) return false;
    const code = creep.upgradeController(creep.room.controller);
    if (code === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, creep.room.controller, 3);
        return true;
    }
    return code === OK;
}

const roleSimpleHarvest = {
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
            clearAssignment(creep);
            return;
        }

        if (mission.type !== 'simple_harvest') {
            roleUniversal.run(creep);
            return;
        }

        movement.enableTrafficForBuildWorker(creep);
        if (creep.memory.task !== undefined) delete creep.memory.task;
        if (creep.memory.taskState !== undefined) delete creep.memory.taskState;

        const data = mission.data || {};
        const memo = getSimpleHarvestRoomMemo(creep.room);
        const sourceId = data.sourceId || mission.sourceId || mission.targetId;
        const source = sourceId ? getObjectByIdCached(memo, sourceId) : null;
        if (!source) {
            clearAssignment(creep);
            return;
        }

        const resourceType = data.resourceType || RESOURCE_ENERGY;
        const carried = creep.store[resourceType] || 0;
        const free = creep.store.getFreeCapacity(resourceType) || 0;
        const full = free <= 0;
        const empty = carried <= 0;
        const sourceDepleted = Number.isFinite(source.energy) && source.energy <= 0;

        let state = creep.memory.minerState;
        if (state !== 'harvest' && state !== 'work') {
            state = empty ? 'harvest' : 'work';
        }

        if (state === 'harvest') {
            if (full || (carried > 0 && sourceDepleted)) {
                state = 'work';
            }
        } else {
            if (empty) {
                state = 'harvest';
            }
        }

        creep.memory.minerState = state;

        if (state === 'harvest') {
            const harvestCode = creep.harvest(source);
            if (harvestCode === ERR_NOT_IN_RANGE) {
                moveToTarget(creep, source, 1);
            }
            return;
        }

        const transferTarget = getFirstValidDropoff(data.dropoffIds, resourceType, memo);
        if (transferTarget) {
            const transferCode = creep.transfer(transferTarget, resourceType);
            if (transferCode === ERR_NOT_IN_RANGE) {
                moveToTarget(
                    creep,
                    transferTarget,
                    Number.isFinite(data.dropoffRange) ? data.dropoffRange : 1
                );
            }
            return;
        }

        if (data.fallback === 'upgrade') {
            const upgraded = tryUpgradeFallback(creep);
            if (upgraded) return;
        }

        moveToTarget(creep, source, 1);
    }
};

module.exports = roleSimpleHarvest;