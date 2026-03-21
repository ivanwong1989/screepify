const borderNav = require('utils_creepBorderNav');
const roleUniversal = require('role_role.universal');
const movement = require('utils_movement');
const heap = require('utils_heap');

const WORKER_MISSION_TYPES = new Set(['build', 'repair', 'fortify']);
const WORKER_STATE_GATHER = 'g';
const WORKER_STATE_WORK = 'w';
const WORKER_HEAP_STORE = 'roleWorker';

function getWorkerRoomMemo(room) {
    if (!room) return null;
    const store = heap.getStore(WORKER_HEAP_STORE, { ttl: 50 });
    const existing = store[room.name];
    if (existing && existing.time === Game.time) return existing;
    const memo = {
        time: Game.time,
        idObj: Object.create(null)
    };
    store[room.name] = memo;
    return memo;
}

function getRoomCache(room) {
    if (!room || typeof global.getRoomCache !== 'function') return null;
    return global.getRoomCache(room);
}

function roomHasCoreLaneMission(room, memo) {
    if (!room) return false;
    if (memo && memo.hasCoreLaneMission !== undefined) return memo.hasCoreLaneMission;
    const missions = Array.isArray(room._missions) ? room._missions : [];
    for (let i = 0; i < missions.length; i++) {
        const mission = missions[i];
        if (mission && mission.type === 'logisticsCoreV2') {
            if (memo) memo.hasCoreLaneMission = true;
            return true;
        }
    }
    if (memo) memo.hasCoreLaneMission = false;
    return false;
}

function roomHasActiveCoreLaneHauler(room, memo, roomCache) {
    if (!room) return false;
    if (memo && memo.hasActiveCoreLaneHauler !== undefined) return memo.hasActiveCoreLaneHauler;

    const creeps = (roomCache && Array.isArray(roomCache.myCreeps))
        ? roomCache.myCreeps
        : room.find(FIND_MY_CREEPS);
    for (let i = 0; i < creeps.length; i++) {
        const c = creeps[i];
        if (!c || !c.memory) continue;
        if (c.memory.role !== 'coreLaneHauler') continue;
        if (c.memory.missionType && c.memory.missionType !== 'logisticsCoreV2') continue;
        if (memo) memo.hasActiveCoreLaneHauler = true;
        return true;
    }
    if (memo) memo.hasActiveCoreLaneHauler = false;
    return false;
}

function clearWorkerAssignment(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.missionName;
    delete creep.memory.task;
    delete creep.memory.taskState;
    delete creep.memory.workerState;
    delete creep.memory._trafficMove;
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

function getObjectByIdCached(memo, id) {
    if (!id) return null;
    if (!memo) return Game.getObjectById(id);
    if (memo.idObj[id] === undefined) memo.idObj[id] = Game.getObjectById(id) || null;
    return memo.idObj[id];
}

function getClosestWithdrawIntentByIds(creep, ids, memo) {
    if (!creep || !Array.isArray(ids) || ids.length <= 0) return null;
    let best = null;
    let bestRange = Infinity;
    for (let i = 0; i < ids.length; i++) {
        const target = getObjectByIdCached(memo, ids[i]);
        if (!target || !target.pos || !target.store || typeof target.store.getUsedCapacity !== 'function') continue;
        const amount = getEnergyAmount(target);
        if (amount <= 0) continue;
        const range = creep.pos.getRangeTo(target.pos);
        if (!best || range < bestRange) {
            best = target;
            bestRange = range;
        }
    }
    if (!best) return null;
    return { type: 'withdraw', target: best };
}

function getDroppedEnergy(room, roomCache, memo) {
    if (!room) return [];
    if (memo && memo.droppedEnergy) return memo.droppedEnergy;

    const dropped = (roomCache && Array.isArray(roomCache.dropped))
        ? roomCache.dropped
        : room.find(FIND_DROPPED_RESOURCES);
    const energy = dropped.filter(r => r && r.resourceType === RESOURCE_ENERGY && r.amount > 0);

    if (memo) memo.droppedEnergy = energy;
    return energy;
}

function getNonEmptyContainers(room, roomCache, memo) {
    if (!room) return [];
    if (memo && memo.nonEmptyContainers) return memo.nonEmptyContainers;

    const containers = (roomCache && roomCache.structuresByType && Array.isArray(roomCache.structuresByType[STRUCTURE_CONTAINER]))
        ? roomCache.structuresByType[STRUCTURE_CONTAINER]
        : room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER });
    const nonEmpty = containers.filter(s =>
        s &&
        s.store &&
        typeof s.store.getUsedCapacity === 'function' &&
        s.store.getUsedCapacity(RESOURCE_ENERGY) > 0
    );

    if (memo) memo.nonEmptyContainers = nonEmpty;
    return nonEmpty;
}

function getActiveSources(room, roomCache, memo) {
    if (!room) return [];
    if (memo && memo.sourcesActive) return memo.sourcesActive;

    const sources = (roomCache && Array.isArray(roomCache.sourcesActive))
        ? roomCache.sourcesActive
        : room.find(FIND_SOURCES_ACTIVE);

    if (memo) memo.sourcesActive = sources;
    return sources;
}

function getEnergyIntent(creep, mission, memo, roomCache) {
    const room = creep.room;
    const roomStorage = room && room.storage ? room.storage : null;
    const isBuildOrRepairMission = !!(mission && (mission.type === 'build' || mission.type === 'repair' || mission.type === 'fortify'));
    const disallowSourceHarvestMission = mission && (mission.type === 'build' || mission.type === 'repair' || mission.type === 'fortify');
    const allowSourceHarvest = !disallowSourceHarvestMission;

    if (isBuildOrRepairMission) {
        const nonMiningContainerIds = mission && mission.data && Array.isArray(mission.data.nonMiningContainerIds)
            ? mission.data.nonMiningContainerIds
            : [];
        const preferred = getClosestWithdrawIntentByIds(creep, nonMiningContainerIds, memo);
        if (preferred) return preferred;
    }

    if (roomStorage) {
        if (getEnergyAmount(roomStorage) > 0) {
            return { type: 'withdraw', target: roomStorage };
        }
    }

    const dropped = getDroppedEnergy(room, roomCache, memo);
    if (dropped.length > 0) {
        const bestDrop = creep.pos.findClosestByRange(dropped);
        if (bestDrop) return { type: 'pickup', target: bestDrop };
    }

    const ids = mission && mission.data && Array.isArray(mission.data.sourceIds) ? mission.data.sourceIds : [];
    let bestGather = null;
    let bestGatherRange = Infinity;
    let bestHarvest = null;
    let bestHarvestRange = Infinity;
    const canHarvest = creep.getActiveBodyparts(WORK) > 0;
    const canHarvestFromSources = canHarvest && allowSourceHarvest;

    for (let i = 0; i < ids.length; i++) {
        const target = getObjectByIdCached(memo, ids[i]);
        if (!target || !target.pos) continue;

        if (target.resourceType === RESOURCE_ENERGY) {
            const amount = getEnergyAmount(target);
            if (amount > 0) {
                const range = creep.pos.getRangeTo(target.pos);
                if (range < bestGatherRange) {
                    bestGather = { type: 'pickup', target };
                    bestGatherRange = range;
                }
            }
            continue;
        }

        if (target.store && typeof target.store.getUsedCapacity === 'function') {
            const amount = getEnergyAmount(target);
            if (amount > 0) {
                const range = creep.pos.getRangeTo(target.pos);
                if (range < bestGatherRange) {
                    bestGather = { type: 'withdraw', target };
                    bestGatherRange = range;
                }
            }
            continue;
        }

        if (canHarvestFromSources && target instanceof Source) {
            const amount = getEnergyAmount(target);
            if (amount > 0) {
                const range = creep.pos.getRangeTo(target.pos);
                if (range < bestHarvestRange) {
                    bestHarvest = { type: 'harvest', target };
                    bestHarvestRange = range;
                }
            }
        }
    }

    if (bestGather) return bestGather;
    if (bestHarvest) return bestHarvest;

    let best = null;
    if (!best) {
        const stores = getNonEmptyContainers(room, roomCache, memo);
        if (stores.length > 0) best = creep.pos.findClosestByRange(stores);
    }

    if (!best && canHarvestFromSources) {
        const sources = getActiveSources(room, roomCache, memo);
        if (sources.length > 0) {
            const source = creep.pos.findClosestByRange(sources);
            if (source) return { type: 'harvest', target: source };
        }
    }

    if (!best) return null;

    if (best.resourceType === RESOURCE_ENERGY) {
        return { type: 'pickup', target: best };
    }
    return { type: 'withdraw', target: best };
}

function getRelevantSources(creep, mission) {
    const ids = mission && mission.data && Array.isArray(mission.data.sourceIds) ? mission.data.sourceIds : [];
    const sources = [];
    for (let i = 0; i < ids.length; i++) {
        const target = Game.getObjectById(ids[i]);
        if (target instanceof Source) sources.push(target);
    }

    if (sources.length > 0) return sources;
    if (!creep || !creep.room) return [];
    return creep.room.find(FIND_SOURCES);
}

function moveWorkerTo(creep, target, range, useTraffic) {
    if (!creep || !target) return;
    if (useTraffic) {
        movement.planMoveTo(creep, target, {
            range: Number.isFinite(range) ? range : 1,
            maxRooms: 1
        });
        return;
    }
    borderNav.moveToTarget(creep, target, range);
}

function vacateSourceRingIfNeeded(creep, mission, allowSourceRing, useTraffic) {
    if (!creep || allowSourceRing) return false;

    const sources = getRelevantSources(creep, mission);
    if (!sources || sources.length <= 0) return false;

    let nearest = null;
    let nearestRange = Infinity;
    for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        if (!source || !source.pos) continue;
        const range = creep.pos.getRangeTo(source.pos);
        if (range < nearestRange) {
            nearest = source;
            nearestRange = range;
        }
    }

    if (!nearest || nearestRange > 1) return false;
    moveWorkerTo(creep, nearest, 2, useTraffic);
    return true;
}

function runGather(creep, mission, useTraffic) {
    const roomCache = getRoomCache(creep.room);
    const memo = getWorkerRoomMemo(creep.room);
    const intent = getEnergyIntent(creep, mission, memo, roomCache);
    const allowSourceRing = !!(intent && intent.type === 'harvest' && intent.target instanceof Source);
    if (vacateSourceRingIfNeeded(creep, mission, allowSourceRing, useTraffic)) return;
    if (!intent || !intent.target) {
        if ((creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0) {
            creep.memory.workerState = WORKER_STATE_WORK;
        }
        return;
    }

    if (intent.type === 'pickup') {
        const result = creep.pickup(intent.target);
        if (result === ERR_NOT_IN_RANGE) {
            moveWorkerTo(creep, intent.target, 1, useTraffic);
        } else if (result === ERR_FULL || result === ERR_INVALID_TARGET) {
            creep.memory.workerState = WORKER_STATE_WORK;
        }
        return;
    }
    if (intent.type === 'harvest') {
        const result = creep.harvest(intent.target);
        if (result === ERR_NOT_IN_RANGE) {
            moveWorkerTo(creep, intent.target, 1, useTraffic);
        } else if (result === ERR_FULL || result === ERR_NOT_ENOUGH_RESOURCES) {
            creep.memory.workerState = WORKER_STATE_WORK;
        }
        return;
    }
    const result = creep.withdraw(intent.target, RESOURCE_ENERGY);
    if (result === ERR_NOT_IN_RANGE) {
        moveWorkerTo(creep, intent.target, 1, useTraffic);
    } else if (result === ERR_FULL || result === ERR_NOT_ENOUGH_RESOURCES || result === ERR_INVALID_TARGET) {
        creep.memory.workerState = WORKER_STATE_WORK;
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
        movement.planMoveTo(creep, target, { range: 3, maxRooms: 1 });
    } else if (result === ERR_NOT_ENOUGH_RESOURCES) {
        creep.memory.workerState = WORKER_STATE_GATHER;
    } else if (result === ERR_INVALID_TARGET) {
        clearWorkerAssignment(creep);
    } else if (result === ERR_NO_BODYPART) {
        clearWorkerAssignment(creep);
    }
}

function isFortifyStructure(structure) {
    if (!structure) return false;
    return structure.structureType === STRUCTURE_WALL || structure.structureType === STRUCTURE_RAMPART;
}

function getMissionQueueTarget(mission) {
    const data = mission && mission.data ? mission.data : null;
    const queueStoreName = data && data.queueStore ? data.queueStore : null;
    const queueKey = data && data.queueKey ? data.queueKey : null;
    if (!queueStoreName || !queueKey) return null;

    const store = heap.getStore(queueStoreName, { ttl: null });
    const entry = store[queueKey];
    const ids = entry && Array.isArray(entry.ids) ? entry.ids : [];
    if (ids.length <= 0) return null;

    const fortify = !!(data && data.fortify);
    const fallbackTargetHits = Number.isFinite(data && data.targetHits) ? data.targetHits : null;
    for (let i = 0; i < ids.length; i++) {
        const target = Game.getObjectById(ids[i]);
        if (!target || !Number.isFinite(target.hits) || !Number.isFinite(target.hitsMax)) continue;
        const isFort = isFortifyStructure(target);
        if (fortify && !isFort) continue;
        if (!fortify && isFort) continue;
        const targetHits = fortify
            ? Math.min(fallbackTargetHits || target.hitsMax, target.hitsMax)
            : Math.floor(target.hitsMax * 0.9);
        if (target.hits < targetHits) return { target, targetHits };
    }
    return null;
}

function runRepair(creep, mission, useTraffic) {
    const queued = getMissionQueueTarget(mission);
    let target = queued ? queued.target : null;
    let targetHits = queued ? queued.targetHits : null;

    if (!target && mission && mission.targetId) {
        target = Game.getObjectById(mission.targetId);
        targetHits = mission && mission.data && Number.isFinite(mission.data.targetHits)
            ? mission.data.targetHits
            : (target ? target.hitsMax : null);
    }

    if (!target) {
        clearWorkerAssignment(creep);
        return;
    }

    if (Number.isFinite(target.hits) && Number.isFinite(targetHits) && target.hits >= targetHits) {
        if (!queued) clearWorkerAssignment(creep);
        return;
    }

    const result = creep.repair(target);
    if (result === ERR_NOT_IN_RANGE) {
        moveWorkerTo(creep, target, 3, useTraffic);
    } else if (result === ERR_INVALID_TARGET) {
        if (!queued) clearWorkerAssignment(creep);
    }
}

function normalizeWorkerState(state) {
    if (state === 'work') return WORKER_STATE_WORK;
    if (state === 'gather') return WORKER_STATE_GATHER;
    if (state === WORKER_STATE_WORK || state === WORKER_STATE_GATHER) return state;
    return null;
}

const roleWorker = {
    run: function(creep) {
        if (!creep || !creep.memory) return;

        const missionName = creep.memory.missionName;
        if (!missionName) {
            const roomMemo = getWorkerRoomMemo(creep.room);
            const roomCache = getRoomCache(creep.room);
            const hasCoreLaneScope = roomHasCoreLaneMission(creep.room, roomMemo) || roomHasActiveCoreLaneHauler(creep.room, roomMemo, roomCache);
            if (hasCoreLaneScope) {
                movement.enableTrafficBlockerOnly(creep, {
                    anchorPos: creep.pos,
                    range: 1
                });
                if (Memory.debugTraffic && typeof debug === 'function') {
                    debug(
                        'traffic',
                        `[BuildTraffic] blocker_only creep=${creep.name} room=${creep.room.name} mission=none reason=core_lane_active`
                    );
                }
                return;
            }
            if (Memory.debugTraffic && typeof debug === 'function') {
                debug(
                    'traffic',
                    `[BuildTraffic] skip blocker_only creep=${creep.name} room=${creep.room.name} mission=none reason=no_core_lane_scope`
                );
            }
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

        const useTraffic = true;
        if (useTraffic) {
            movement.enableTrafficForBuildWorker(creep);
            if (Memory.debugTraffic && typeof debug === 'function') {
                debug(
                    'traffic',
                    `[WorkerTraffic] enroll creep=${creep.name} mission=${missionName} type=${mission.type} target=${mission.targetId || '-'} blockerMovable=1`
                );
            }
        }

        if (creep.memory.task !== undefined) delete creep.memory.task;
        if (creep.memory.taskState !== undefined) delete creep.memory.taskState;

        const used = creep.store.getUsedCapacity(RESOURCE_ENERGY);
        const free = creep.store.getFreeCapacity(RESOURCE_ENERGY);
        let workerState = normalizeWorkerState(creep.memory.workerState);
        if (workerState !== WORKER_STATE_WORK && used > 0 && free === 0) {
            workerState = WORKER_STATE_WORK;
        } else if (workerState === WORKER_STATE_WORK && used === 0) {
            workerState = WORKER_STATE_GATHER;
        } else if (!workerState) {
            workerState = used > 0 ? WORKER_STATE_WORK : WORKER_STATE_GATHER;
        }
        if (creep.memory.workerState !== workerState) creep.memory.workerState = workerState;

        if (workerState === WORKER_STATE_GATHER) {
            runGather(creep, mission, useTraffic);
            return;
        }

        if (mission.type === 'build') {
            runBuild(creep, mission);
            return;
        }

        runRepair(creep, mission, useTraffic);
    }
};

module.exports = roleWorker;
