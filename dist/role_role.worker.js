const borderNav = require('utils_creepBorderNav');
const roleUniversal = require('role_role.universal');

const WORKER_MISSION_TYPES = new Set(['build', 'repair']);

function clearWorkerAssignment(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.missionName;
    delete creep.memory.task;
    delete creep.memory.taskState;
    delete creep.memory.workerState;
}

function getMissionByName(homeRoom, missionName) {
    if (!homeRoom || !missionName) return null;
    if (homeRoom._workerMissionMapTick !== Game.time || !homeRoom._workerMissionMap) {
        const map = Object.create(null);
        const missions = Array.isArray(homeRoom._missions) ? homeRoom._missions : [];
        for (let i = 0; i < missions.length; i++) {
            const mission = missions[i];
            if (!mission || !mission.name) continue;
            map[mission.name] = mission;
        }
        homeRoom._workerMissionMap = map;
        homeRoom._workerMissionMapTick = Game.time;
    }
    return homeRoom._workerMissionMap[missionName] || null;
}

function getEnergyAmount(target) {
    if (!target) return 0;
    if (target.store && typeof target.store.getUsedCapacity === 'function') {
        return target.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    }
    if (target.resourceType === RESOURCE_ENERGY) return target.amount || 0;
    if (target instanceof Source) return target.energy || 0;
    if (Number.isFinite(target.energy)) return target.energy;
    return 0;
}

function getEnergyIntent(creep, mission) {
    const room = creep.room;
    const roomStorage = room && room.storage ? room.storage : null;
    if (roomStorage) {
        if (getEnergyAmount(roomStorage) > 0) {
            return { type: 'withdraw', target: roomStorage };
        }
        return null;
    }

    const dropped = room.find(FIND_DROPPED_RESOURCES, {
        filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 0
    });
    if (dropped.length > 0) {
        const bestDrop = creep.pos.findClosestByRange(dropped);
        if (bestDrop) return { type: 'pickup', target: bestDrop };
    }

    const ids = mission && mission.data && Array.isArray(mission.data.sourceIds) ? mission.data.sourceIds : [];
    let best = null;
    let bestRange = Infinity;

    for (let i = 0; i < ids.length; i++) {
        const target = Game.getObjectById(ids[i]);
        if (!target || target.structureType !== STRUCTURE_CONTAINER) continue;
        const amount = getEnergyAmount(target);
        if (amount <= 0) continue;
        const range = creep.pos.getRangeTo(target.pos);
        if (range < bestRange) {
            best = target;
            bestRange = range;
        }
    }

    if (!best) {
        const stores = room.find(FIND_STRUCTURES, {
            filter: s =>
                s.store &&
                typeof s.store.getUsedCapacity === 'function' &&
                s.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
                s.structureType === STRUCTURE_CONTAINER
        });
        if (stores.length > 0) best = creep.pos.findClosestByRange(stores);
    }

    if (!best) return null;

    if (best.resourceType === RESOURCE_ENERGY) {
        return { type: 'pickup', target: best };
    }
    return { type: 'withdraw', target: best };
}

function runGather(creep, mission) {
    const intent = getEnergyIntent(creep, mission);
    if (!intent || !intent.target) return;

    if (intent.type === 'pickup') {
        if (creep.pickup(intent.target) === ERR_NOT_IN_RANGE) {
            borderNav.moveToTarget(creep, intent.target, 1);
        }
        return;
    }
    if (creep.withdraw(intent.target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        borderNav.moveToTarget(creep, intent.target, 1);
    }
}

function runBuild(creep, mission) {
    const target = mission && mission.targetId ? Game.getObjectById(mission.targetId) : null;
    if (!target) {
        clearWorkerAssignment(creep);
        return;
    }
    const result = creep.build(target);
    if (result === ERR_NOT_IN_RANGE) {
        borderNav.moveToTarget(creep, target, 3);
    } else if (result === ERR_INVALID_TARGET) {
        clearWorkerAssignment(creep);
    }
}

function runRepair(creep, mission) {
    const target = mission && mission.targetId ? Game.getObjectById(mission.targetId) : null;
    if (!target) {
        clearWorkerAssignment(creep);
        return;
    }

    const targetHits = mission && mission.data && Number.isFinite(mission.data.targetHits)
        ? mission.data.targetHits
        : target.hitsMax;
    if (Number.isFinite(target.hits) && Number.isFinite(targetHits) && target.hits >= targetHits) {
        clearWorkerAssignment(creep);
        return;
    }

    const result = creep.repair(target);
    if (result === ERR_NOT_IN_RANGE) {
        borderNav.moveToTarget(creep, target, 3);
    } else if (result === ERR_INVALID_TARGET) {
        clearWorkerAssignment(creep);
    }
}

const roleWorker = {
    run: function(creep) {
        if (!creep || !creep.memory) return;

        const missionName = creep.memory.missionName;
        if (!missionName) {
            roleUniversal.run(creep);
            return;
        }

        const homeRoomName = creep.memory.room || (creep.room && creep.room.name);
        const homeRoom = homeRoomName ? Game.rooms[homeRoomName] : null;
        const mission = getMissionByName(homeRoom, missionName);
        if (!mission) {
            clearWorkerAssignment(creep);
            return;
        }

        if (!WORKER_MISSION_TYPES.has(mission.type)) {
            roleUniversal.run(creep);
            return;
        }

        delete creep.memory.task;
        delete creep.memory.taskState;

        const used = creep.store.getUsedCapacity(RESOURCE_ENERGY);
        const free = creep.store.getFreeCapacity(RESOURCE_ENERGY);
        if (creep.memory.workerState !== 'work' && used > 0 && free === 0) {
            creep.memory.workerState = 'work';
        } else if (creep.memory.workerState === 'work' && used === 0) {
            creep.memory.workerState = 'gather';
        } else if (!creep.memory.workerState) {
            creep.memory.workerState = used > 0 ? 'work' : 'gather';
        }

        if (creep.memory.workerState === 'gather') {
            runGather(creep, mission);
            return;
        }

        if (mission.type === 'build') {
            runBuild(creep, mission);
            return;
        }

        runRepair(creep, mission);
    }
};

module.exports = roleWorker;
