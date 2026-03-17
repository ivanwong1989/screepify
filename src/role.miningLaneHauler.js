const missionBoard = require('managers_overseer_missions_board_missionBoard');
const missionRuntime = require('managers_overseer_missions_board_missionRuntime');

const STATE_LOAD = 'LOAD';
const STATE_DELIVER = 'DELIVER';

function posKey(pos) {
    return pos ? `${pos.roomName}:${pos.x},${pos.y}` : '';
}

function getMissionForCreep(creep) {
    if (!creep || !creep.memory) return null;
    const byId = creep.memory.miningLaneMissionId || creep.memory.missionId || null;
    if (byId) {
        const mission = missionBoard.getById(byId);
        if (mission && mission.type === 'logisticsMiningV2') return mission;
    }

    const home = creep.memory.room || (creep.room && creep.room.name);
    if (!home) return null;
    const missionName = creep.memory.missionName || null;
    const live = missionBoard.listLiveByRoom(home) || [];
    for (let i = 0; i < live.length; i++) {
        const mission = live[i];
        if (!mission || mission.type !== 'logisticsMiningV2') continue;
        const mName = mission.meta && mission.meta.missionName ? mission.meta.missionName : null;
        if (missionName && mName && missionName !== mName) continue;
        creep.memory.miningLaneMissionId = mission.id;
        creep.memory.missionId = mission.id;
        creep.memory.missionType = 'logisticsMiningV2';
        return mission;
    }
    return null;
}

function getRuntime(mission) {
    if (!mission) return null;
    const runtime = missionRuntime.getMissionRuntime(mission);
    if (!runtime || !Array.isArray(runtime.path) || runtime.path.length <= 0) return null;
    return runtime;
}

function getCurrentIndex(creep, runtime) {
    if (!creep || !runtime || !runtime.indexByPos) return -1;
    const idx = runtime.indexByPos[posKey(creep.pos)];
    return Number.isInteger(idx) ? idx : -1;
}

function moveToNearestPathTile(creep, runtime) {
    if (!creep || !runtime || !Array.isArray(runtime.path)) return;
    let best = null;
    let bestRange = Infinity;
    for (let i = 0; i < runtime.path.length; i++) {
        const tile = runtime.path[i];
        if (!tile || tile.roomName !== creep.room.name) continue;
        const range = creep.pos.getRangeTo(tile);
        if (range < bestRange) {
            bestRange = range;
            best = tile;
        }
    }
    if (best) creep.moveTo(best, { range: 0, reusePath: 3 });
}

function stepTowardIndex(creep, runtime, targetIndex) {
    if (!creep || !runtime || !Array.isArray(runtime.path)) return;
    const path = runtime.path;
    if (targetIndex < 0 || targetIndex >= path.length) return;

    const currentIndex = getCurrentIndex(creep, runtime);
    if (currentIndex < 0) {
        moveToNearestPathTile(creep, runtime);
        return;
    }
    if (currentIndex === targetIndex) return;
    const nextIndex = currentIndex < targetIndex ? currentIndex + 1 : currentIndex - 1;
    const nextPos = path[nextIndex];
    if (!nextPos) return;
    creep.move(creep.pos.getDirectionTo(nextPos));
}

function getSinkTarget(creep, runtime, mission) {
    const fromRuntime = runtime && runtime.sinkId ? Game.getObjectById(runtime.sinkId) : null;
    if (fromRuntime && fromRuntime.store && fromRuntime.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return fromRuntime;
    const fromMeta = mission && mission.meta && mission.meta.sinkId ? Game.getObjectById(mission.meta.sinkId) : null;
    if (fromMeta && fromMeta.store && fromMeta.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return fromMeta;
    if (creep.room.storage && creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return creep.room.storage;

    const containers = creep.room.find(FIND_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_CONTAINER &&
            s.store &&
            s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
    });
    return containers.length > 0 ? containers[0] : null;
}

function findPickupTarget(creep, runtime) {
    if (!creep || !runtime) return null;
    if (runtime.pickupId) {
        const source = Game.getObjectById(runtime.pickupId);
        if (source && source.store && (source.store[RESOURCE_ENERGY] || 0) > 0) {
            return { obj: source, kind: 'store' };
        }
    }
    const anchor = runtime.pickupPos;
    if (!anchor) return null;
    const look = creep.room.lookForAt(LOOK_RESOURCES, anchor.x, anchor.y) || [];
    let best = null;
    for (let i = 0; i < look.length; i++) {
        const res = look[i];
        if (!res || res.resourceType !== RESOURCE_ENERGY || res.amount <= 0) continue;
        if (!best || res.amount > best.amount) best = res;
    }
    if (best) return { obj: best, kind: 'drop' };
    const nearby = anchor.findInRange(FIND_DROPPED_RESOURCES, 1, {
        filter: r => r && r.resourceType === RESOURCE_ENERGY && r.amount > 0
    });
    if (!nearby || nearby.length <= 0) return null;
    nearby.sort((a, b) => b.amount - a.amount);
    return { obj: nearby[0], kind: 'drop' };
}

function clearAssignment(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.miningLaneMissionId;
    delete creep.memory.missionId;
    delete creep.memory.missionType;
    delete creep.memory.miningLaneState;
}

module.exports = {
    run(creep) {
        if (!creep || !creep.my) return;
        const mission = getMissionForCreep(creep);
        if (!mission) {
            clearAssignment(creep);
            return;
        }

        const runtime = getRuntime(mission);
        if (!runtime) return;
        if (!creep.memory.miningLaneState) creep.memory.miningLaneState = STATE_LOAD;
        if ((creep.store[RESOURCE_ENERGY] || 0) <= 0) creep.memory.miningLaneState = STATE_LOAD;
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) creep.memory.miningLaneState = STATE_DELIVER;

        if (creep.memory.miningLaneState === STATE_LOAD) {
            const pickup = findPickupTarget(creep, runtime);
            const sourceIndex = 0;

            if (pickup && pickup.obj && creep.pos.inRangeTo(pickup.obj, 1)) {
                if (pickup.kind === 'store') {
                    creep.withdraw(pickup.obj, RESOURCE_ENERGY);
                } else {
                    creep.pickup(pickup.obj);
                }
                if ((creep.store[RESOURCE_ENERGY] || 0) > 0) creep.memory.miningLaneState = STATE_DELIVER;
                return;
            }

            const atSourceIndex = getCurrentIndex(creep, runtime) === sourceIndex;
            if (!atSourceIndex) {
                stepTowardIndex(creep, runtime, sourceIndex);
                return;
            }

            if (runtime.pickupPos && !creep.pos.inRangeTo(runtime.pickupPos, 1)) {
                creep.moveTo(runtime.pickupPos, { range: 1, reusePath: 3 });
            }
            return;
        }

        const sink = getSinkTarget(creep, runtime, mission);
        if (!sink) return;
        if ((creep.store[RESOURCE_ENERGY] || 0) <= 0) {
            creep.memory.miningLaneState = STATE_LOAD;
            return;
        }

        const endIndex = Math.max(0, (runtime.path.length || 1) - 1);
        const idx = getCurrentIndex(creep, runtime);
        if (idx < 0) {
            moveToNearestPathTile(creep, runtime);
            return;
        }

        if (idx < endIndex) {
            stepTowardIndex(creep, runtime, endIndex);
            return;
        }

        if (!creep.pos.inRangeTo(sink, 1)) {
            creep.moveTo(sink, { range: 1, reusePath: 3 });
            return;
        }

        creep.transfer(sink, RESOURCE_ENERGY);
        if ((creep.store[RESOURCE_ENERGY] || 0) <= 0) {
            creep.memory.miningLaneState = STATE_LOAD;
        }
    }
};

