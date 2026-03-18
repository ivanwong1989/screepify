const missionBoard = require('managers_overseer_missions_board_missionBoard');
const missionRuntime = require('managers_overseer_missions_board_missionRuntime');

const STATE_LOAD = 'LOAD';
const STATE_DELIVER = 'DELIVER';
const DIRECT_DELIVER_LOAD_RATIO = 0.8;
const DIRECT_NO_PICKUP_GRACE_TICKS = 20;
const LANE_NO_PICKUP_GRACE_TICKS = 120;

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

function findPickupTarget(creep, runtime, mission) {
    if (!creep || !runtime) return null;
    if (runtime.pickupId) {
        const source = Game.getObjectById(runtime.pickupId);
        if (source && source.store && (source.store[RESOURCE_ENERGY] || 0) > 0) {
            return { obj: source, kind: 'store' };
        }
    }
    const anchor = runtime.pickupPos;
    if (anchor) {
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
        if (nearby && nearby.length > 0) {
            nearby.sort((a, b) => b.amount - a.amount);
            if (nearby[0]) return { obj: nearby[0], kind: 'drop' };
        }
    }

    // Fallback: for drop-mining, energy can appear on any source-adjacent tile, not only around the cached anchor.
    const source = mission && mission.targetId ? Game.getObjectById(mission.targetId) : null;
    if (source && source.pos) {
        const aroundSource = source.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
            filter: r => r && r.resourceType === RESOURCE_ENERGY && r.amount > 0
        });
        if (aroundSource && aroundSource.length > 0) {
            aroundSource.sort((a, b) => {
                if (b.amount !== a.amount) return b.amount - a.amount;
                return creep.pos.getRangeTo(a.pos) - creep.pos.getRangeTo(b.pos);
            });
            return { obj: aroundSource[0], kind: 'drop' };
        }
    }
    return null;
}

function clearAssignment(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.miningLaneMissionId;
    delete creep.memory.missionId;
    delete creep.memory.missionType;
    delete creep.memory.miningLaneState;
    delete creep.memory.miningLaneNoPickupTicks;
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
        if (!runtime) {
            debugLog(creep, mission, null, 'NO_RUNTIME');
            return;
        }
        const laneMode = hasLanePath(runtime);
        if (!creep.memory.miningLaneState) creep.memory.miningLaneState = STATE_LOAD;
        if ((creep.store[RESOURCE_ENERGY] || 0) <= 0) creep.memory.miningLaneState = STATE_LOAD;
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) creep.memory.miningLaneState = STATE_DELIVER;
        if (!Number.isFinite(creep.memory.miningLaneNoPickupTicks)) creep.memory.miningLaneNoPickupTicks = 0;

        if (creep.memory.miningLaneState === STATE_LOAD) {
            const pickup = findPickupTarget(creep, runtime, mission);
            if (pickup) creep.memory.miningLaneNoPickupTicks = 0;

            if (pickup && pickup.obj && creep.pos.inRangeTo(pickup.obj, 1)) {
                let code = ERR_INVALID_TARGET;
                if (pickup.kind === 'store') {
                    code = creep.withdraw(pickup.obj, RESOURCE_ENERGY);
                } else {
                    code = creep.pickup(pickup.obj);
                }
                debugLog(creep, mission, runtime, 'LOAD_PICKUP_ATTEMPT', `kind=${pickup.kind} target=${pickup.obj.id || '-'} code=${code}`);
                if (creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) {
                    creep.memory.miningLaneState = STATE_DELIVER;
                    debugLog(creep, mission, runtime, 'LOAD_FULL_SWITCH_TO_DELIVER');
                }
                return;
            }

            const carried = creep.store[RESOURCE_ENERGY] || 0;
            if (!pickup && carried > 0) {
                const capacity = Math.max(1, creep.store.getCapacity(RESOURCE_ENERGY) || 0);
                const loadRatio = carried / capacity;
                creep.memory.miningLaneNoPickupTicks = (creep.memory.miningLaneNoPickupTicks || 0) + 1;
                const waited = creep.memory.miningLaneNoPickupTicks;

                if (laneMode) {
                    // Lane haulers should prefer full loads to avoid small-payload churn.
                    if (waited >= LANE_NO_PICKUP_GRACE_TICKS) {
                        creep.memory.miningLaneState = STATE_DELIVER;
                        debugLog(
                            creep,
                            mission,
                            runtime,
                            'LOAD_NO_PICKUP_SWITCH_TO_DELIVER',
                            `carried=${carried} ratio=${loadRatio.toFixed(2)} waited=${waited} mode=lane_grace`
                        );
                        return;
                    }
                }

                if (!laneMode) {
                    const shouldDeliver =
                        loadRatio >= DIRECT_DELIVER_LOAD_RATIO ||
                        waited >= DIRECT_NO_PICKUP_GRACE_TICKS;
                    if (shouldDeliver) {
                        creep.memory.miningLaneState = STATE_DELIVER;
                        debugLog(
                            creep,
                            mission,
                            runtime,
                            'LOAD_NO_PICKUP_SWITCH_TO_DELIVER',
                            `carried=${carried} ratio=${loadRatio.toFixed(2)} waited=${waited}`
                        );
                        return;
                    }
                }
            }

            if (!pickup && carried <= 0 && !laneMode && mission && mission.targetId) {
                creep.memory.miningLaneNoPickupTicks = (creep.memory.miningLaneNoPickupTicks || 0) + 1;
                const source = Game.getObjectById(mission.targetId);
                if (source && source.pos && !creep.pos.inRangeTo(source.pos, 1)) {
                    const moveCode = creep.moveTo(source.pos, { range: 1, reusePath: 6 });
                    debugLog(
                        creep,
                        mission,
                        runtime,
                        'LOAD_NO_PICKUP_MOVE_TO_SOURCE',
                        `source=${source.id} code=${moveCode}`
                    );
                    return;
                }
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

            if (runtime.pickupPos && !creep.pos.inRangeTo(runtime.pickupPos, 1)) {
                const moveCode = creep.moveTo(runtime.pickupPos, { range: 1, reusePath: laneMode ? 3 : 8 });
                debugLog(
                    creep,
                    mission,
                    runtime,
                    'LOAD_AT_SOURCE_MOVE_TO_PICKUP',
                    `pickupPos=${runtime.pickupPos.roomName}:${runtime.pickupPos.x},${runtime.pickupPos.y} code=${moveCode}`
                );
                return;
            }
            debugLog(creep, mission, runtime, 'LOAD_NO_PICKUP_SEEN');
            return;
        }

        creep.memory.miningLaneNoPickupTicks = 0;

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
                const moveCode = creep.moveTo(sink, { range: 1, reusePath: 3 });
                debugLog(creep, mission, runtime, 'OFFLANE_DELIVER_DIRECT_TO_SINK', `sink=${sink.id || '-'} code=${moveCode}`);
                return;
            }

            if (idx < endIndex) {
                stepTowardIndex(creep, runtime, endIndex);
                debugLog(creep, mission, runtime, 'ONLANE_STEP_TO_END', `end=${endIndex}`);
                return;
            }
        }

        const moveCode = creep.moveTo(sink, { range: 1, reusePath: laneMode ? 3 : 8 });
        debugLog(creep, mission, runtime, 'ON_END_MOVE_TO_SINK', `sink=${sink.id || '-'} code=${moveCode}`);
    }
};
