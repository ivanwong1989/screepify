const missionBoard = require('managers_overseer_missions_board_missionBoard');
const movement = require('utils_movement');
const heap = require('utils_heap');

const STATE_LOAD = 'LOAD';
const STATE_DELIVER = 'DELIVER';
const TOWER_REFILL_MIN_FREE = 100;
const SIMPLE_CORE_ROLE_STORE = 'roleSimpleHaulerCore';

function logSimpleCoreRoleDebug(creep, message) {
    if (typeof debug !== 'function' || !creep) return;
    debug('mission.logistics', `[SimpleCoreRole] ${creep.name} ${message}`);
}

function getRoleRoomMemo(homeRoomName) {
    if (!homeRoomName) return null;
    const store = heap.getStore(SIMPLE_CORE_ROLE_STORE, { ttl: 50 });
    const existing = store[homeRoomName];
    if (existing && existing.time === Game.time) return existing;
    const memo = {
        time: Game.time,
        mission: undefined,
        idObj: Object.create(null),
        anchorSpawn: null
    };
    store[homeRoomName] = memo;
    return memo;
}

function getObjectByIdCached(id, memo) {
    if (!id) return null;
    if (!memo) return Game.getObjectById(id);
    if (memo.idObj[id] === undefined) memo.idObj[id] = Game.getObjectById(id) || null;
    return memo.idObj[id];
}

function getRoomCache(room) {
    if (!room || typeof global.getRoomCache !== 'function') return null;
    return global.getRoomCache(room);
}

function getAnchorSpawn(room, memo) {
    if (!room) return null;
    if (memo && memo.anchorSpawn !== null) return memo.anchorSpawn;
    const roomCache = getRoomCache(room);
    const spawns = (roomCache && roomCache.myStructuresByType && Array.isArray(roomCache.myStructuresByType[STRUCTURE_SPAWN]))
        ? roomCache.myStructuresByType[STRUCTURE_SPAWN]
        : room.find(FIND_MY_SPAWNS);
    const anchor = spawns && spawns.length > 0 ? spawns[0] : null;
    if (memo) memo.anchorSpawn = anchor || null;
    return anchor;
}

function getSimpleMission(homeRoomName, memo) {
    if (!homeRoomName) return null;
    if (memo && memo.mission !== undefined) return memo.mission;
    const live = missionBoard.listLiveByRoom(homeRoomName) || [];
    for (let i = 0; i < live.length; i++) {
        const mission = live[i];
        if (mission && mission.type === 'logisticsSimpleCore') {
            if (memo) memo.mission = mission;
            return mission;
        }
    }
    if (memo) memo.mission = null;
    return null;
}

function getObjectsByIds(ids, memo) {
    const out = [];
    if (!Array.isArray(ids)) return out;
    for (let i = 0; i < ids.length; i++) {
        const obj = getObjectByIdCached(ids[i], memo);
        if (obj) out.push(obj);
    }
    return out;
}

function getRefillTargets(mission, room, memo) {
    const fromMission = getObjectsByIds(mission && mission.data ? mission.data.refillTargetIds : [], memo);
    const valid = fromMission.filter(s => {
        if (!s || !s.store || typeof s.store.getFreeCapacity !== 'function') return false;
        const free = s.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
        if (s.structureType === STRUCTURE_TOWER) return free >= TOWER_REFILL_MIN_FREE;
        return free > 0;
    });
    if (valid.length > 0) return valid;

    if (!room) return [];
    const roomCache = getRoomCache(room);
    const myStructures = roomCache && Array.isArray(roomCache.myStructures)
        ? roomCache.myStructures
        : room.find(FIND_MY_STRUCTURES);
    return myStructures.filter(s => {
        if (!s || !s.store || typeof s.store.getFreeCapacity !== 'function') return false;
        if (
            s.structureType !== STRUCTURE_SPAWN &&
            s.structureType !== STRUCTURE_EXTENSION &&
            s.structureType !== STRUCTURE_TOWER
        ) return false;
        const free = s.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
        if (s.structureType === STRUCTURE_TOWER) return free >= TOWER_REFILL_MIN_FREE;
        return free > 0;
    });
}

function pickBestEnergySource(creep, mission, room, blockedSourceIds, memo) {
    if (!creep || !room) return null;
    const blocked = blockedSourceIds instanceof Set ? blockedSourceIds : new Set();

    const preferredIds = mission && mission.data && Array.isArray(mission.data.sourceIds)
        ? mission.data.sourceIds
        : [];
    const preferred = getObjectsByIds(preferredIds, memo).filter(obj => {
        if (!obj) return false;
        if (obj.id && blocked.has(obj.id)) return false;
        if (obj.store) return (obj.store[RESOURCE_ENERGY] || 0) > 0;
        if (obj.resourceType === RESOURCE_ENERGY && Number.isFinite(obj.amount)) return obj.amount > 0;
        return false;
    });
    if (preferred.length > 0) return creep.pos.findClosestByPath(preferred) || creep.pos.findClosestByRange(preferred);

    const dropped = room.find(FIND_DROPPED_RESOURCES, {
        filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 0 && (!r.id || !blocked.has(r.id))
    });
    if (dropped.length > 0) return creep.pos.findClosestByPath(dropped) || creep.pos.findClosestByRange(dropped);

    const tombstones = room.find(FIND_TOMBSTONES, {
        filter: t => t.store && (t.store[RESOURCE_ENERGY] || 0) > 0 && (!t.id || !blocked.has(t.id))
    });
    if (tombstones.length > 0) return creep.pos.findClosestByPath(tombstones) || creep.pos.findClosestByRange(tombstones);

    const ruins = room.find(FIND_RUINS, {
        filter: r => r.store && (r.store[RESOURCE_ENERGY] || 0) > 0 && (!r.id || !blocked.has(r.id))
    });
    if (ruins.length > 0) return creep.pos.findClosestByPath(ruins) || creep.pos.findClosestByRange(ruins);

    const structures = room.find(FIND_STRUCTURES, {
        filter: s => {
            if (s.id && blocked.has(s.id)) return false;
            if (!s.store) return false;
            if ((s.store[RESOURCE_ENERGY] || 0) <= 0) return false;
            return (
                s.structureType === STRUCTURE_CONTAINER ||
                s.structureType === STRUCTURE_STORAGE ||
                s.structureType === STRUCTURE_TERMINAL ||
                s.structureType === STRUCTURE_LINK
            );
        }
    });
    if (structures.length > 0) return creep.pos.findClosestByPath(structures) || creep.pos.findClosestByRange(structures);
    return null;
}

function moveHome(creep) {
    if (!creep || !creep.memory || !creep.memory.room) return;
    const homeRoom = creep.memory.room;
    if (creep.room.name === homeRoom) return;
    movement.planMoveTo(creep, new RoomPosition(25, 25, homeRoom), { range: 20, maxRooms: 16 });
}

function moveToTarget(creep, target, range) {
    if (!creep || !target) return;
    const pos = target.pos || target;
    const targetRoomName = pos && pos.roomName ? pos.roomName : null;
    movement.planMoveTo(creep, target, {
        range: Number.isFinite(range) ? range : 1,
        maxRooms: (targetRoomName && creep.room && targetRoomName !== creep.room.name) ? 16 : 1
    });
}

module.exports = {
    run(creep) {
        if (!creep || !creep.my || !creep.memory) return;

        const homeRoomName = creep.memory.room || (creep.room && creep.room.name);
        const memo = getRoleRoomMemo(homeRoomName);
        const mission = getSimpleMission(homeRoomName, memo);
        const assignedMissionName = creep.memory.missionName || null;
        const simpleMissionName = mission && mission.meta && mission.meta.missionName
            ? mission.meta.missionName
            : `logistics:simpleCore:${homeRoomName}`;

        // Simple-core role must only run when explicitly assigned to simple-core mission.
        if (assignedMissionName !== simpleMissionName) {
            if (creep.memory.simpleHaulerState !== undefined) delete creep.memory.simpleHaulerState;
            if (creep.memory.task !== undefined) delete creep.memory.task;
            if (creep.memory._trafficMove !== undefined) delete creep.memory._trafficMove;
            return;
        }

        if (!mission) {
            logSimpleCoreRoleDebug(
                creep,
                `unassign noMission home=${homeRoomName || '-'} oldMissionName=${creep.memory.missionName || '-'} ` +
                `state=${creep.memory.simpleHaulerState || '-'} carry=${creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0}`
            );
            if (creep.memory.missionName !== undefined) delete creep.memory.missionName;
            if (creep.memory.task !== undefined) delete creep.memory.task;
            if (creep.memory.taskState !== undefined) delete creep.memory.taskState;
            if (creep.memory.simpleHaulerState !== undefined) delete creep.memory.simpleHaulerState;
            if (creep.memory._trafficMove !== undefined) delete creep.memory._trafficMove;
            return;
        }
        movement.enableTrafficForBuildWorker(creep);
        if (creep.room.name !== homeRoomName) {
            moveHome(creep);
            return;
        }

        if (!creep.memory.simpleHaulerState) creep.memory.simpleHaulerState = STATE_LOAD;
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) <= 0) creep.memory.simpleHaulerState = STATE_LOAD;
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) creep.memory.simpleHaulerState = STATE_DELIVER;
        const refillTargets = getRefillTargets(mission, creep.room, memo);
        const blockedSourceIds = new Set();

        // Keep cargo clean; simple haulers should only carry energy.
        for (const type in creep.store) {
            if (type === RESOURCE_ENERGY) continue;
            if ((creep.store[type] || 0) <= 0) continue;
            const storage = creep.room.storage;
            if (storage && storage.store && storage.store.getFreeCapacity(type) > 0) {
                if (creep.transfer(storage, type) === ERR_NOT_IN_RANGE) {
                    moveToTarget(creep, storage, 1);
                }
                return;
            }
        }

        if (creep.memory.simpleHaulerState === STATE_LOAD) {
            const source = pickBestEnergySource(creep, mission, creep.room, blockedSourceIds, memo);
            if (!source) {
                const anchor = getAnchorSpawn(creep.room, memo);
                if (anchor) moveToTarget(creep, anchor, 2);
                return;
            }

            if (source.resourceType === RESOURCE_ENERGY && Number.isFinite(source.amount)) {
                const code = creep.pickup(source);
                if (code === ERR_NOT_IN_RANGE) moveToTarget(creep, source, 1);
                return;
            }

            if (source.store && (source.store[RESOURCE_ENERGY] || 0) > 0) {
                const code = creep.withdraw(source, RESOURCE_ENERGY);
                if (code === ERR_NOT_IN_RANGE) moveToTarget(creep, source, 1);
                return;
            }
            return;
        }

        if (refillTargets.length <= 0) {
            const anchor = getAnchorSpawn(creep.room, memo);
            if (anchor) moveToTarget(creep, anchor, 2);
            return;
        }

        const target = creep.pos.findClosestByPath(refillTargets) || creep.pos.findClosestByRange(refillTargets);
        if (!target) return;
        const code = creep.transfer(target, RESOURCE_ENERGY);
        if (code === ERR_NOT_IN_RANGE) moveToTarget(creep, target, 1);
    }
};
