const missionBoard = require('managers_overseer_missions_board_missionBoard');

const STATE_LOAD = 'LOAD';
const STATE_DELIVER = 'DELIVER';
const TOWER_REFILL_MIN_FREE = 100;

function getSimpleMission(homeRoomName) {
    if (!homeRoomName) return null;
    const live = missionBoard.listLiveByRoom(homeRoomName) || [];
    for (let i = 0; i < live.length; i++) {
        const mission = live[i];
        if (mission && mission.type === 'logisticsSimpleCore') return mission;
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

function getRefillTargets(mission, room) {
    const fromMission = getObjectsByIds(mission && mission.data ? mission.data.refillTargetIds : []);
    const valid = fromMission.filter(s => {
        if (!s || !s.store || typeof s.store.getFreeCapacity !== 'function') return false;
        const free = s.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
        if (s.structureType === STRUCTURE_TOWER) return free >= TOWER_REFILL_MIN_FREE;
        return free > 0;
    });
    if (valid.length > 0) return valid;

    if (!room) return [];
    return room.find(FIND_MY_STRUCTURES, {
        filter: s => {
            if (!s || !s.store || typeof s.store.getFreeCapacity !== 'function') return false;
            if (
                s.structureType !== STRUCTURE_SPAWN &&
                s.structureType !== STRUCTURE_EXTENSION &&
                s.structureType !== STRUCTURE_TOWER
            ) return false;
            const free = s.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
            if (s.structureType === STRUCTURE_TOWER) return free >= TOWER_REFILL_MIN_FREE;
            return free > 0;
        }
    });
}

function getSinkTargets(mission, room) {
    const fromMission = getObjectsByIds(mission && mission.data ? mission.data.sinkTargetIds : []);
    const valid = fromMission.filter(s => s && s.store && (s.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 0);
    if (valid.length > 0) return valid;

    if (!room) return [];
    const spawns = room.find(FIND_MY_SPAWNS);
    if (!spawns || spawns.length <= 0) return [];
    const containers = room.find(FIND_STRUCTURES, {
        filter: s =>
            s.structureType === STRUCTURE_CONTAINER &&
            s.store &&
            (s.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 0
    });
    return containers.filter(c => spawns.some(spawn => spawn.pos.getRangeTo(c.pos) <= 3));
}

function pickBestEnergySource(creep, mission, room) {
    if (!creep || !room) return null;

    const preferredIds = mission && mission.data && Array.isArray(mission.data.sourceIds)
        ? mission.data.sourceIds
        : [];
    const preferred = getObjectsByIds(preferredIds).filter(obj => {
        if (!obj) return false;
        if (obj.store) return (obj.store[RESOURCE_ENERGY] || 0) > 0;
        if (obj.resourceType === RESOURCE_ENERGY && Number.isFinite(obj.amount)) return obj.amount > 0;
        return false;
    });
    if (preferred.length > 0) return creep.pos.findClosestByPath(preferred) || creep.pos.findClosestByRange(preferred);

    const dropped = room.find(FIND_DROPPED_RESOURCES, {
        filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 0
    });
    if (dropped.length > 0) return creep.pos.findClosestByPath(dropped) || creep.pos.findClosestByRange(dropped);

    const tombstones = room.find(FIND_TOMBSTONES, {
        filter: t => t.store && (t.store[RESOURCE_ENERGY] || 0) > 0
    });
    if (tombstones.length > 0) return creep.pos.findClosestByPath(tombstones) || creep.pos.findClosestByRange(tombstones);

    const ruins = room.find(FIND_RUINS, {
        filter: r => r.store && (r.store[RESOURCE_ENERGY] || 0) > 0
    });
    if (ruins.length > 0) return creep.pos.findClosestByPath(ruins) || creep.pos.findClosestByRange(ruins);

    const structures = room.find(FIND_STRUCTURES, {
        filter: s => {
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
    creep.moveTo(new RoomPosition(25, 25, homeRoom), { range: 20, reusePath: 10 });
}

module.exports = {
    run(creep) {
        if (!creep || !creep.my || !creep.memory) return;

        const homeRoomName = creep.memory.room || (creep.room && creep.room.name);
        const mission = getSimpleMission(homeRoomName);
        const desiredCount = mission && mission.meta && Number.isFinite(mission.meta.desiredCount)
            ? mission.meta.desiredCount
            : 0;
        if (!mission || desiredCount <= 0) {
            creep.memory.role = 'hauler';
            delete creep.memory.missionName;
            delete creep.memory.task;
            delete creep.memory.taskState;
            delete creep.memory.simpleHaulerState;
            return;
        }

        if (creep.room.name !== homeRoomName) {
            moveHome(creep);
            return;
        }

        if (!creep.memory.simpleHaulerState) creep.memory.simpleHaulerState = STATE_LOAD;
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) <= 0) creep.memory.simpleHaulerState = STATE_LOAD;
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) creep.memory.simpleHaulerState = STATE_DELIVER;

        // Keep cargo clean; simple haulers should only carry energy.
        for (const type in creep.store) {
            if (type === RESOURCE_ENERGY) continue;
            if ((creep.store[type] || 0) <= 0) continue;
            const storage = creep.room.storage;
            if (storage && storage.store && storage.store.getFreeCapacity(type) > 0) {
                if (creep.transfer(storage, type) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(storage, { range: 1, reusePath: 5 });
                }
                return;
            }
        }

        if (creep.memory.simpleHaulerState === STATE_LOAD) {
            const source = pickBestEnergySource(creep, mission, creep.room);
            if (!source) {
                const anchor = creep.room.find(FIND_MY_SPAWNS)[0];
                if (anchor) creep.moveTo(anchor, { range: 2, reusePath: 7 });
                return;
            }

            if (source.resourceType === RESOURCE_ENERGY && Number.isFinite(source.amount)) {
                const code = creep.pickup(source);
                if (code === ERR_NOT_IN_RANGE) creep.moveTo(source, { range: 1, reusePath: 5 });
                return;
            }

            if (source.store && (source.store[RESOURCE_ENERGY] || 0) > 0) {
                const code = creep.withdraw(source, RESOURCE_ENERGY);
                if (code === ERR_NOT_IN_RANGE) creep.moveTo(source, { range: 1, reusePath: 5 });
                return;
            }
            return;
        }

        const refillTargets = getRefillTargets(mission, creep.room);
        const targetPool = refillTargets.length > 0 ? refillTargets : getSinkTargets(mission, creep.room);
        if (targetPool.length <= 0) {
            const anchor = creep.room.find(FIND_MY_SPAWNS)[0];
            if (anchor) creep.moveTo(anchor, { range: 2, reusePath: 7 });
            return;
        }

        const target = creep.pos.findClosestByPath(targetPool) || creep.pos.findClosestByRange(targetPool);
        if (!target) return;
        const code = creep.transfer(target, RESOURCE_ENERGY);
        if (code === ERR_NOT_IN_RANGE) creep.moveTo(target, { range: 1, reusePath: 5 });
    }
};
