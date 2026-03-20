const missionBoard = require('managers_overseer_missions_board_missionBoard');
const missionRuntime = require('managers_overseer_missions_board_missionRuntime');
const movement = require('utils_movement');

const STATE_LOAD = 'LOAD';
const STATE_DELIVER = 'DELIVER';

function posKey(pos) {
    return pos ? `${pos.roomName}:${pos.x},${pos.y}` : '';
}

function isDebugEnabled(creep) {
    if (!Memory || !Memory.debugMiningLaneV2) return false;
    if (Memory.debugMiningLaneV2 === true) return true;
    if (creep && creep.memory && Memory.debugMiningLaneV2 === creep.memory.room) return true;
    return false;
}

function debugLog(creep, mission, runtime, event, extra) {
    if (!isDebugEnabled(creep)) return;
    const state = creep && creep.memory ? creep.memory.miningLaneState : '?';
    const energy = creep && creep.store ? (creep.store[RESOURCE_ENERGY] || 0) : 0;
    const free = creep && creep.store ? creep.store.getFreeCapacity(RESOURCE_ENERGY) : 0;
    const idx = creep && runtime ? getCurrentIndex(creep, runtime) : -1;
    const pathLen = runtime && Array.isArray(runtime.path) ? runtime.path.length : 0;
    const sinkId = runtime && runtime.sinkId ? runtime.sinkId : (mission && mission.meta ? mission.meta.sinkId : null);
    const pickupId = runtime && runtime.pickupId ? runtime.pickupId : (mission && mission.meta ? mission.meta.pickupId : null);
    const pos = creep && creep.pos ? `${creep.pos.roomName}:${creep.pos.x},${creep.pos.y}` : '?';
    console.log(
        `[MiningLaneV2] ${event} creep=${creep ? creep.name : '?'} mission=${mission ? mission.id : '-'} ` +
        `state=${state} e=${energy} free=${free} idx=${idx}/${Math.max(0, pathLen - 1)} pos=${pos} ` +
        `pickup=${pickupId || '-'} sink=${sinkId || '-'}${extra ? ` ${extra}` : ''}`
    );
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
    return runtime || null;
}

function hasLanePath(runtime) {
    return !!(runtime &&
        runtime.useLane === true &&
        Array.isArray(runtime.path) &&
        runtime.path.length > 0 &&
        runtime.indexByPos);
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
    if (best) movement.planMoveTo(creep, best, { range: 0, maxRooms: 1 });
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
    movement.planMoveTo(creep, nextPos, { range: 0, maxRooms: 1 });
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

function getPickupContainer(runtime, mission) {
    const runtimePickupId = runtime && runtime.pickupId ? runtime.pickupId : null;
    const missionPickupId = mission && mission.meta && mission.meta.pickupId ? mission.meta.pickupId : null;
    const pickupId = runtimePickupId || missionPickupId;
    if (!pickupId) return null;
    const container = Game.getObjectById(pickupId);
    if (!container || !container.store) return null;
    return container;
}

function getSourceLink(runtime, mission) {
    const runtimeLinkId = runtime && runtime.sourceLinkId ? runtime.sourceLinkId : null;
    const missionLinkId = mission && mission.meta && mission.meta.linkId ? mission.meta.linkId : null;
    const linkId = runtimeLinkId || missionLinkId;
    if (!linkId) return null;
    const link = Game.getObjectById(linkId);
    if (!link || link.structureType !== STRUCTURE_LINK || !link.store) return null;
    return link;
}

function getStationPos(runtime, mission) {
    const runtimePos = runtime && runtime.stationPos ? runtime.stationPos : null;
    const missionPos = mission && mission.meta && mission.meta.stationPos ? mission.meta.stationPos : null;
    const pos = runtimePos || missionPos;
    if (!pos || pos.x === undefined || pos.y === undefined || !pos.roomName) return null;
    return new RoomPosition(pos.x, pos.y, pos.roomName);
}

function runLinkOverflowMode(creep, mission, runtime) {
    const pickup = getPickupContainer(runtime, mission);
    const sourceLink = getSourceLink(runtime, mission);
    if (!pickup || !sourceLink) {
        debugLog(creep, mission, runtime, 'LINK_OVERFLOW_MISSING_TARGETS');
        return;
    }

    const stationPos = getStationPos(runtime, mission);
    if (stationPos && !creep.pos.isEqualTo(stationPos)) {
        const moveCode = movement.planMoveTo(creep, stationPos, { range: 0, maxRooms: 1 });
        debugLog(creep, mission, runtime, 'LINK_OVERFLOW_MOVE_TO_STATION', `code=${moveCode}`);
        return;
    }

    const nearPickup = creep.pos.inRangeTo(pickup, 1);
    const nearLink = creep.pos.inRangeTo(sourceLink, 1);
    if (!nearPickup || !nearLink) {
        const moveTarget = nearPickup ? sourceLink : pickup;
        const moveCode = movement.planMoveTo(creep, moveTarget, { range: 1, maxRooms: 1 });
        debugLog(creep, mission, runtime, 'LINK_OVERFLOW_REPOSITION', `target=${moveTarget.id} code=${moveCode}`);
        return;
    }

    const carried = creep.store[RESOURCE_ENERGY] || 0;
    const linkFree = sourceLink.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
    const containerEnergy = pickup.store[RESOURCE_ENERGY] || 0;

    if (carried > 0 && linkFree > 0) {
        const transferCode = creep.transfer(sourceLink, RESOURCE_ENERGY);
        debugLog(creep, mission, runtime, 'LINK_OVERFLOW_TRANSFER', `code=${transferCode}`);
        return;
    }

    if (containerEnergy > 0 && creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        const withdrawCode = creep.withdraw(pickup, RESOURCE_ENERGY);
        debugLog(creep, mission, runtime, 'LINK_OVERFLOW_WITHDRAW', `code=${withdrawCode}`);
        return;
    }

    debugLog(creep, mission, runtime, 'LINK_OVERFLOW_IDLE', `carried=${carried} linkFree=${linkFree} container=${containerEnergy}`);
}

function clearAssignment(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.miningLaneMissionId;
    delete creep.memory.missionId;
    delete creep.memory.missionType;
    delete creep.memory.miningLaneState;
    delete creep.memory._trafficMove;
}

module.exports = {
    run(creep) {
        if (!creep || !creep.my) return;
        movement.enableTrafficForCoreLaneHauler(creep);

        const mission = getMissionForCreep(creep);
        if (!mission) {
            clearAssignment(creep);
            return;
        }

        const runtime = getRuntime(mission);
        if (!runtime) {
            debugLog(creep, mission, null, 'NO_RUNTIME');
            return;
        }
        const linkOverflowMode =
            (runtime && runtime.linkAssistActive === true) ||
            (mission && mission.meta && mission.meta.pathMode === 'link_overflow');
        if (linkOverflowMode) {
            runLinkOverflowMode(creep, mission, runtime);
            return;
        }
        const laneMode = hasLanePath(runtime);
        if (!creep.memory.miningLaneState) creep.memory.miningLaneState = STATE_LOAD;
        if ((creep.store[RESOURCE_ENERGY] || 0) <= 0) creep.memory.miningLaneState = STATE_LOAD;
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) creep.memory.miningLaneState = STATE_DELIVER;

        if (creep.memory.miningLaneState === STATE_LOAD) {
            const pickup = getPickupContainer(runtime, mission);
            if (!pickup) {
                debugLog(creep, mission, runtime, 'LOAD_NO_PICKUP_CONTAINER');
                return;
            }

            const carried = creep.store[RESOURCE_ENERGY] || 0;
            const pickupEnergy = pickup.store[RESOURCE_ENERGY] || 0;
            // Prefer full loads to reduce half trips; only force a partial return near end-of-life.
            if (
                carried > 0 &&
                pickupEnergy <= 0 &&
                Number.isFinite(creep.ticksToLive) &&
                creep.ticksToLive <= 80
            ) {
                creep.memory.miningLaneState = STATE_DELIVER;
                debugLog(
                    creep,
                    mission,
                    runtime,
                    'LOAD_CONTAINER_EMPTY_EOL_SWITCH_TO_DELIVER',
                    `carried=${carried} ttl=${creep.ticksToLive}`
                );
                return;
            }

            if (laneMode) {
                const sourceIndex = 0;
                const idx = getCurrentIndex(creep, runtime);
                if (idx < 0) {
                    moveToNearestPathTile(creep, runtime);
                    debugLog(creep, mission, runtime, 'LOAD_OFFLANE_REJOIN');
                    return;
                }
                if (idx > sourceIndex) {
                    stepTowardIndex(creep, runtime, sourceIndex);
                    debugLog(creep, mission, runtime, 'LOAD_ONLANE_STEP_TO_SOURCE', `idx=${idx} target=${sourceIndex}`);
                    return;
                }
            }

            if (!creep.pos.inRangeTo(pickup, 1)) {
                const moveCode = movement.planMoveTo(creep, pickup, { range: 1, maxRooms: 1 });
                debugLog(
                    creep,
                    mission,
                    runtime,
                    'LOAD_AT_SOURCE_MOVE_TO_PICKUP',
                    `pickupId=${pickup.id} code=${moveCode}`
                );
                return;
            }

            const withdrawCode = creep.withdraw(pickup, RESOURCE_ENERGY);
            debugLog(creep, mission, runtime, 'LOAD_PICKUP_ATTEMPT', `kind=store target=${pickup.id} code=${withdrawCode}`);
            if (creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) {
                creep.memory.miningLaneState = STATE_DELIVER;
                debugLog(creep, mission, runtime, 'LOAD_FULL_SWITCH_TO_DELIVER');
            }
            return;
        }

        const sink = getSinkTarget(creep, runtime, mission);
        if (!sink) {
            debugLog(creep, mission, runtime, 'DELIVER_NO_SINK');
            return;
        }
        if ((creep.store[RESOURCE_ENERGY] || 0) <= 0) {
            creep.memory.miningLaneState = STATE_LOAD;
            debugLog(creep, mission, runtime, 'DELIVER_EMPTY_SWITCH_TO_LOAD');
            return;
        }

        if (creep.pos.inRangeTo(sink, 1)) {
            const transferCode = creep.transfer(sink, RESOURCE_ENERGY);
            debugLog(creep, mission, runtime, 'DELIVER_TRANSFER_ATTEMPT', `sink=${sink.id || '-'} code=${transferCode}`);
            if ((creep.store[RESOURCE_ENERGY] || 0) <= 0) {
                creep.memory.miningLaneState = STATE_LOAD;
            }
            return;
        }

        if (laneMode) {
            const endIndex = Math.max(0, (runtime.path.length || 1) - 1);
            const idx = getCurrentIndex(creep, runtime);
            if (idx < 0) {
                const moveCode = movement.planMoveTo(creep, sink, { range: 1, maxRooms: 1 });
                debugLog(creep, mission, runtime, 'OFFLANE_DELIVER_DIRECT_TO_SINK', `sink=${sink.id || '-'} code=${moveCode}`);
                return;
            }

            if (idx < endIndex) {
                stepTowardIndex(creep, runtime, endIndex);
                debugLog(creep, mission, runtime, 'ONLANE_STEP_TO_END', `end=${endIndex}`);
                return;
            }
        }

        const moveCode = movement.planMoveTo(creep, sink, { range: 1, maxRooms: 1 });
        debugLog(creep, mission, runtime, 'ON_END_MOVE_TO_SINK', `sink=${sink.id || '-'} code=${moveCode}`);
    }
};
