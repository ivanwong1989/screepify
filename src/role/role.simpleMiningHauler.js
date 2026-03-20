const missionBoard = require('managers_overseer_missions_board_missionBoard');
const movement = require('utils_movement');
const heap = require('utils_heap');

const STATE_LOAD = 'L';
const STATE_DELIVER = 'D';
const ROLE_SIMPLE_MINING_HAULER_STORE = 'roleSimpleMiningHauler';

function getRoleStore() {
    return heap.getStore(ROLE_SIMPLE_MINING_HAULER_STORE, { ttl: 50 });
}

function getRoomMemo(roomName) {
    if (!roomName) return null;
    const store = getRoleStore();
    const existing = store[roomName];
    if (existing && existing.time === Game.time) return existing;
    const memo = {
        time: Game.time,
        mission: undefined,
        sourceIdSetByMissionId: Object.create(null),
        idObj: Object.create(null),
        anchorSpawn: null
    };
    store[roomName] = memo;
    return memo;
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

function getObjectByIdCached(id, memo) {
    if (!id) return null;
    if (!memo) return Game.getObjectById(id);
    if (memo.idObj[id] === undefined) memo.idObj[id] = Game.getObjectById(id) || null;
    return memo.idObj[id];
}

function getMission(homeRoomName, memo) {
    if (!homeRoomName) return null;
    if (memo && memo.mission !== undefined) return memo.mission;
    const live = missionBoard.listLiveByRoom(homeRoomName) || [];
    for (let i = 0; i < live.length; i++) {
        const mission = live[i];
        if (mission && mission.type === 'logisticsSimpleMining') {
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

function getSourceTargets(mission, memo) {
    const fromMission = getObjectsByIds(mission && mission.data ? mission.data.sourceIds : [], memo);
    return fromMission.filter(obj => {
        if (!obj) return false;
        if (obj.store) return (obj.store[RESOURCE_ENERGY] || 0) > 0;
        if (obj.resourceType === RESOURCE_ENERGY && Number.isFinite(obj.amount)) return obj.amount > 0;
        return false;
    });
}

function getSinkTargets(mission, memo) {
    const fromMission = getObjectsByIds(mission && mission.data ? mission.data.sinkIds : [], memo);
    return fromMission.filter(obj =>
        obj &&
        obj.store &&
        (obj.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 0
    );
}

function getMissionSourceIdSet(mission, memo) {
    if (!mission) return new Set();
    if (memo && mission.id && memo.sourceIdSetByMissionId[mission.id]) return memo.sourceIdSetByMissionId[mission.id];
    const set = new Set();
    const ids = mission && mission.data && Array.isArray(mission.data.sourceIds)
        ? mission.data.sourceIds
        : [];
    for (let i = 0; i < ids.length; i++) {
        if (ids[i]) set.add(ids[i]);
    }
    if (memo && mission.id) memo.sourceIdSetByMissionId[mission.id] = set;
    return set;
}

function isEnergySourceObject(obj) {
    if (!obj) return false;
    if (obj.store) return (obj.store[RESOURCE_ENERGY] || 0) > 0;
    if (obj.resourceType === RESOURCE_ENERGY && Number.isFinite(obj.amount)) return obj.amount > 0;
    return false;
}

function pickPreferredSource(creep, sources) {
    if (!creep || !Array.isArray(sources) || sources.length <= 0) return null;
    const stores = sources.filter(s => !!(s && s.store));
    if (stores.length > 0) {
        return creep.pos.findClosestByPath(stores) || creep.pos.findClosestByRange(stores);
    }
    return creep.pos.findClosestByPath(sources) || creep.pos.findClosestByRange(sources);
}

function getLockedSource(mission, sourceId, memo) {
    if (!sourceId || !mission) return null;
    const sourceIdSet = getMissionSourceIdSet(mission, memo);
    if (!sourceIdSet.has(sourceId)) return null;
    return getObjectByIdCached(sourceId, memo) || null;
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
        const memo = getRoomMemo(homeRoomName);
        const mission = getMission(homeRoomName, memo);
        if (!mission) {
            if (creep.memory.missionName !== undefined) delete creep.memory.missionName;
            if (creep.memory.task !== undefined) delete creep.memory.task;
            if (creep.memory.taskState !== undefined) delete creep.memory.taskState;
            if (creep.memory.simpleMiningState !== undefined) delete creep.memory.simpleMiningState;
            if (creep.memory.simpleMiningSourceId !== undefined) delete creep.memory.simpleMiningSourceId;
            if (creep.memory._trafficMove !== undefined) delete creep.memory._trafficMove;
            return;
        }
        movement.enableTrafficForBuildWorker(creep);

        if (creep.room.name !== homeRoomName) {
            moveHome(creep);
            return;
        }

        const desiredCount = mission && mission.meta && Number.isFinite(mission.meta.desiredCount)
            ? mission.meta.desiredCount
            : 0;
        let state = creep.memory.simpleMiningState;
        if (state === 'LOAD') state = STATE_LOAD;
        else if (state === 'DELIVER') state = STATE_DELIVER;
        if (!state) state = STATE_LOAD;
        if ((creep.store[RESOURCE_ENERGY] || 0) <= 0) state = STATE_LOAD;
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) state = STATE_DELIVER;
        if (creep.memory.simpleMiningState !== state) creep.memory.simpleMiningState = state;

        if (desiredCount <= 0 && (creep.store[RESOURCE_ENERGY] || 0) <= 0) {
            const anchor = getAnchorSpawn(creep.room, memo);
            if (anchor) moveToTarget(creep, anchor, 2);
            return;
        }

        if (state === STATE_LOAD) {
            const carried = creep.store[RESOURCE_ENERGY] || 0;
            const sources = getSourceTargets(mission, memo);
            let source = getLockedSource(mission, creep.memory.simpleMiningSourceId, memo);

            if (!source || !isEnergySourceObject(source)) {
                source = pickPreferredSource(creep, sources);
                const nextSourceId = source && source.id ? source.id : null;
                if (creep.memory.simpleMiningSourceId !== nextSourceId) creep.memory.simpleMiningSourceId = nextSourceId;
            }

            if (sources.length <= 0) {
                // Stay parked at the mining side when partially loaded; do not bounce back and forth.
                if (carried > 0) {
                    const locked = getLockedSource(mission, creep.memory.simpleMiningSourceId, memo);
                    if (locked && !creep.pos.inRangeTo(locked, 1)) {
                        moveToTarget(creep, locked, 1);
                    }
                } else {
                    const anchor = getAnchorSpawn(creep.room, memo);
                    if (anchor) moveToTarget(creep, anchor, 2);
                }
                return;
            }

            if (!source) return;
            if (source.resourceType === RESOURCE_ENERGY && Number.isFinite(source.amount)) {
                const code = creep.pickup(source);
                if (code === ERR_NOT_IN_RANGE) moveToTarget(creep, source, 1);
                return;
            }

            const code = creep.withdraw(source, RESOURCE_ENERGY);
            if (code === ERR_NOT_IN_RANGE) moveToTarget(creep, source, 1);
            return;
        }

        const sinks = getSinkTargets(mission, memo);
        if (sinks.length <= 0) {
            const anchor = getAnchorSpawn(creep.room, memo);
            if (anchor) moveToTarget(creep, anchor, 2);
            return;
        }
        const sink = creep.pos.findClosestByPath(sinks) || creep.pos.findClosestByRange(sinks);
        if (!sink) return;
        const code = creep.transfer(sink, RESOURCE_ENERGY);
        if (code === ERR_NOT_IN_RANGE) moveToTarget(creep, sink, 1);
        if ((creep.store[RESOURCE_ENERGY] || 0) <= 0) {
            if (creep.memory.simpleMiningState !== STATE_LOAD) creep.memory.simpleMiningState = STATE_LOAD;
        }
    }
};
