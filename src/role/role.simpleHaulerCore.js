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

function isEnergySourceObject(obj) {
    if (!obj) return false;
    if (obj.store) return (obj.store[RESOURCE_ENERGY] || 0) > 0;
    if (obj.resourceType === RESOURCE_ENERGY && Number.isFinite(obj.amount)) return obj.amount > 0;
    return false;
}

function isRefillTargetObject(obj) {
    if (!obj || !obj.store || typeof obj.store.getFreeCapacity !== 'function') return false;
    if (
        obj.structureType !== STRUCTURE_SPAWN &&
        obj.structureType !== STRUCTURE_EXTENSION &&
        obj.structureType !== STRUCTURE_TOWER
    ) return false;
    const free = obj.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
    if (obj.structureType === STRUCTURE_TOWER) return free >= TOWER_REFILL_MIN_FREE;
    return free > 0;
}

function pickClosestTarget(creep, targets) {
    if (!creep || !Array.isArray(targets) || targets.length <= 0) return null;
    return creep.pos.findClosestByRange(targets) || creep.pos.findClosestByPath(targets);
}

function getRefillTargets(mission, room, memo) {
    const fromMission = getObjectsByIds(mission && mission.data ? mission.data.refillTargetIds : [], memo);
    const valid = fromMission.filter(isRefillTargetObject);
    if (valid.length > 0) return valid;

    if (!room) return [];
    const roomCache = getRoomCache(room);
    const myStructures = roomCache && Array.isArray(roomCache.myStructures)
        ? roomCache.myStructures
        : room.find(FIND_MY_STRUCTURES);
    return myStructures.filter(isRefillTargetObject);
}

function getFallbackEnergySources(room, blockedSourceIds, memo) {
    if (!room) return [];
    const blocked = blockedSourceIds instanceof Set ? blockedSourceIds : new Set();
    const roomCache = getRoomCache(room);

    const droppedAll = roomCache && Array.isArray(roomCache.dropped)
        ? roomCache.dropped
        : room.find(FIND_DROPPED_RESOURCES);
    const dropped = droppedAll.filter(r =>
        r &&
        r.resourceType === RESOURCE_ENERGY &&
        r.amount > 0 &&
        (!r.id || !blocked.has(r.id))
    );

    const tombstonesAll = roomCache && Array.isArray(roomCache.tombstones)
        ? roomCache.tombstones
        : room.find(FIND_TOMBSTONES);
    const tombstones = tombstonesAll.filter(t =>
        t &&
        t.store &&
        (t.store[RESOURCE_ENERGY] || 0) > 0 &&
        (!t.id || !blocked.has(t.id))
    );

    const ruinsAll = roomCache && Array.isArray(roomCache.ruins)
        ? roomCache.ruins
        : room.find(FIND_RUINS);
    const ruins = ruinsAll.filter(r =>
        r &&
        r.store &&
        (r.store[RESOURCE_ENERGY] || 0) > 0 &&
        (!r.id || !blocked.has(r.id))
    );

    let structures = [];
    if (roomCache && roomCache.structuresByType) {
        const byType = roomCache.structuresByType;
        structures = []
            .concat(byType[STRUCTURE_CONTAINER] || [])
            .concat(byType[STRUCTURE_STORAGE] || [])
            .concat(byType[STRUCTURE_TERMINAL] || [])
            .concat(byType[STRUCTURE_LINK] || []);
    } else {
        structures = room.find(FIND_STRUCTURES, {
            filter: s =>
                s &&
                s.store &&
                (
                    s.structureType === STRUCTURE_CONTAINER ||
                    s.structureType === STRUCTURE_STORAGE ||
                    s.structureType === STRUCTURE_TERMINAL ||
                    s.structureType === STRUCTURE_LINK
                )
        });
    }

    const stores = structures.filter(s =>
        s &&
        (!s.id || !blocked.has(s.id)) &&
        s.store &&
        (s.store[RESOURCE_ENERGY] || 0) > 0
    );

    if (memo) {
        memo.fallbackEnergySourceCount = dropped.length + tombstones.length + ruins.length + stores.length;
    }
    return dropped.concat(tombstones, ruins, stores);
}

function pickBestEnergySource(creep, mission, room, blockedSourceIds, memo) {
    if (!creep || !room) return null;
    const blocked = blockedSourceIds instanceof Set ? blockedSourceIds : new Set();

    const preferredIds = mission && mission.data && Array.isArray(mission.data.sourceIds)
        ? mission.data.sourceIds
        : [];
    const preferred = getObjectsByIds(preferredIds, memo).filter(obj => {
        if (!isEnergySourceObject(obj)) return false;
        if (obj.id && blocked.has(obj.id)) return false;
        return true;
    });
    if (preferred.length > 0) return pickClosestTarget(creep, preferred);

    return pickClosestTarget(creep, getFallbackEnergySources(room, blocked, memo));
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
            if (creep.memory.simpleHaulerSourceId !== undefined) delete creep.memory.simpleHaulerSourceId;
            if (creep.memory.simpleHaulerTargetId !== undefined) delete creep.memory.simpleHaulerTargetId;
            if (creep.memory.task !== undefined) delete creep.memory.task;
            if (creep.memory._trafficMove !== undefined) delete creep.memory._trafficMove;
            movement.enableTrafficBlockerOnlyAtCurrentPos(creep);
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
            if (creep.memory.simpleHaulerSourceId !== undefined) delete creep.memory.simpleHaulerSourceId;
            if (creep.memory.simpleHaulerTargetId !== undefined) delete creep.memory.simpleHaulerTargetId;
            if (creep.memory._trafficMove !== undefined) delete creep.memory._trafficMove;
            movement.enableTrafficBlockerOnlyAtCurrentPos(creep);
            return;
        }
        movement.enableTrafficForBuildWorker(creep);
        if (creep.room.name !== homeRoomName) {
            moveHome(creep);
            return;
        }

        if (!creep.memory.simpleHaulerState) creep.memory.simpleHaulerState = STATE_LOAD;
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) <= 0) {
            if (creep.memory.simpleHaulerState !== STATE_LOAD) creep.memory.simpleHaulerState = STATE_LOAD;
            if (creep.memory.simpleHaulerTargetId !== undefined) delete creep.memory.simpleHaulerTargetId;
        }
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) {
            if (creep.memory.simpleHaulerState !== STATE_DELIVER) creep.memory.simpleHaulerState = STATE_DELIVER;
            if (creep.memory.simpleHaulerSourceId !== undefined) delete creep.memory.simpleHaulerSourceId;
        }
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
            let source = getObjectByIdCached(creep.memory.simpleHaulerSourceId, memo);
            if (!isEnergySourceObject(source) || (source && source.id && blockedSourceIds.has(source.id))) {
                source = null;
            }
            if (!source) {
                source = pickBestEnergySource(creep, mission, creep.room, blockedSourceIds, memo);
                const nextSourceId = source && source.id ? source.id : null;
                if (nextSourceId) creep.memory.simpleHaulerSourceId = nextSourceId;
                else if (creep.memory.simpleHaulerSourceId !== undefined) delete creep.memory.simpleHaulerSourceId;
            }
            if (!source) {
                const anchor = getAnchorSpawn(creep.room, memo);
                if (anchor) moveToTarget(creep, anchor, 2);
                return;
            }

            if (source.resourceType === RESOURCE_ENERGY && Number.isFinite(source.amount)) {
                const code = creep.pickup(source);
                if (code === ERR_NOT_IN_RANGE) moveToTarget(creep, source, 1);
                if (code === ERR_INVALID_TARGET || code === ERR_NOT_ENOUGH_RESOURCES) {
                    if (creep.memory.simpleHaulerSourceId !== undefined) delete creep.memory.simpleHaulerSourceId;
                }
                return;
            }

            if (source.store && (source.store[RESOURCE_ENERGY] || 0) > 0) {
                const code = creep.withdraw(source, RESOURCE_ENERGY);
                if (code === ERR_NOT_IN_RANGE) moveToTarget(creep, source, 1);
                if (code === ERR_INVALID_TARGET || code === ERR_NOT_ENOUGH_RESOURCES) {
                    if (creep.memory.simpleHaulerSourceId !== undefined) delete creep.memory.simpleHaulerSourceId;
                }
                return;
            }
            if (creep.memory.simpleHaulerSourceId !== undefined) delete creep.memory.simpleHaulerSourceId;
            return;
        }

        if (refillTargets.length <= 0) {
            const anchor = getAnchorSpawn(creep.room, memo);
            if (anchor) moveToTarget(creep, anchor, 2);
            return;
        }

        let target = getObjectByIdCached(creep.memory.simpleHaulerTargetId, memo);
        if (!isRefillTargetObject(target)) target = null;
        if (!target) {
            target = pickClosestTarget(creep, refillTargets);
            const nextTargetId = target && target.id ? target.id : null;
            if (nextTargetId) creep.memory.simpleHaulerTargetId = nextTargetId;
            else if (creep.memory.simpleHaulerTargetId !== undefined) delete creep.memory.simpleHaulerTargetId;
        }
        if (!target) return;
        const code = creep.transfer(target, RESOURCE_ENERGY);
        if (code === ERR_NOT_IN_RANGE) moveToTarget(creep, target, 1);
        if (code === ERR_INVALID_TARGET || code === ERR_FULL) {
            if (creep.memory.simpleHaulerTargetId !== undefined) delete creep.memory.simpleHaulerTargetId;
        }
    }
};
