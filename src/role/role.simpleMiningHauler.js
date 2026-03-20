const missionBoard = require('managers_overseer_missions_board_missionBoard');
const movement = require('utils_movement');

const STATE_LOAD = 'LOAD';
const STATE_DELIVER = 'DELIVER';

function getMission(homeRoomName) {
    if (!homeRoomName) return null;
    const live = missionBoard.listLiveByRoom(homeRoomName) || [];
    for (let i = 0; i < live.length; i++) {
        const mission = live[i];
        if (mission && mission.type === 'logisticsSimpleMining') return mission;
    }
    return null;
}

function getObjectsByIds(ids) {
    const out = [];
    if (!Array.isArray(ids)) return out;
    for (let i = 0; i < ids.length; i++) {
        const obj = Game.getObjectById(ids[i]);
        if (obj) out.push(obj);
    }
    return out;
}

function getSourceTargets(mission) {
    const fromMission = getObjectsByIds(mission && mission.data ? mission.data.sourceIds : []);
    return fromMission.filter(obj => {
        if (!obj) return false;
        if (obj.store) return (obj.store[RESOURCE_ENERGY] || 0) > 0;
        if (obj.resourceType === RESOURCE_ENERGY && Number.isFinite(obj.amount)) return obj.amount > 0;
        return false;
    });
}

function getSinkTargets(mission) {
    const fromMission = getObjectsByIds(mission && mission.data ? mission.data.sinkIds : []);
    return fromMission.filter(obj =>
        obj &&
        obj.store &&
        (obj.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 0
    );
}

function getMissionSourceIdSet(mission) {
    const set = new Set();
    const ids = mission && mission.data && Array.isArray(mission.data.sourceIds)
        ? mission.data.sourceIds
        : [];
    for (let i = 0; i < ids.length; i++) {
        if (ids[i]) set.add(ids[i]);
    }
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

function getLockedSource(mission, sourceId) {
    if (!sourceId || !mission) return null;
    const sourceIdSet = getMissionSourceIdSet(mission);
    if (!sourceIdSet.has(sourceId)) return null;
    return Game.getObjectById(sourceId) || null;
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
        const mission = getMission(homeRoomName);
        if (!mission) {
            delete creep.memory.missionName;
            delete creep.memory.task;
            delete creep.memory.taskState;
            delete creep.memory.simpleMiningState;
            delete creep.memory.simpleMiningSourceId;
            delete creep.memory._trafficMove;
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
        if (!creep.memory.simpleMiningState) creep.memory.simpleMiningState = STATE_LOAD;
        if ((creep.store[RESOURCE_ENERGY] || 0) <= 0) creep.memory.simpleMiningState = STATE_LOAD;
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) creep.memory.simpleMiningState = STATE_DELIVER;

        if (desiredCount <= 0 && (creep.store[RESOURCE_ENERGY] || 0) <= 0) {
            const anchor = creep.room.find(FIND_MY_SPAWNS)[0];
            if (anchor) moveToTarget(creep, anchor, 2);
            return;
        }

        if (creep.memory.simpleMiningState === STATE_LOAD) {
            const carried = creep.store[RESOURCE_ENERGY] || 0;
            const sources = getSourceTargets(mission);
            let source = getLockedSource(mission, creep.memory.simpleMiningSourceId);

            if (!source || !isEnergySourceObject(source)) {
                source = pickPreferredSource(creep, sources);
                creep.memory.simpleMiningSourceId = source && source.id ? source.id : null;
            }

            if (sources.length <= 0) {
                // Stay parked at the mining side when partially loaded; do not bounce back and forth.
                if (carried > 0) {
                    const locked = getLockedSource(mission, creep.memory.simpleMiningSourceId);
                    if (locked && !creep.pos.inRangeTo(locked, 1)) {
                        moveToTarget(creep, locked, 1);
                    }
                } else {
                    const anchor = creep.room.find(FIND_MY_SPAWNS)[0];
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

        const sinks = getSinkTargets(mission);
        if (sinks.length <= 0) {
            const anchor = creep.room.find(FIND_MY_SPAWNS)[0];
            if (anchor) moveToTarget(creep, anchor, 2);
            return;
        }
        const sink = creep.pos.findClosestByPath(sinks) || creep.pos.findClosestByRange(sinks);
        if (!sink) return;
        const code = creep.transfer(sink, RESOURCE_ENERGY);
        if (code === ERR_NOT_IN_RANGE) moveToTarget(creep, sink, 1);
        if ((creep.store[RESOURCE_ENERGY] || 0) <= 0) {
            creep.memory.simpleMiningState = STATE_LOAD;
        }
    }
};
