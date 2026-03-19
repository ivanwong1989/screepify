const borderNav = require('utils_creepBorderNav');
const laneMovement = require('utils_creepLaneMovement');
const roleUniversal = require('role_role.universal');
const heap = require('utils_heap');
const remoteUtils = require('managers_overseer_utils_overseer.remote');

function clearAssignment(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.missionName;
    delete creep.memory.task;
    delete creep.memory.taskState;
}

function getMissionByName(homeRoom, missionName) {
    if (!homeRoom || !missionName) return null;
    if (homeRoom._remoteHaulMissionMapTick !== Game.time || !homeRoom._remoteHaulMissionMap) {
        const map = Object.create(null);
        const missions = Array.isArray(homeRoom._missions) ? homeRoom._missions : [];
        for (let i = 0; i < missions.length; i++) {
            const mission = missions[i];
            if (!mission || !mission.name) continue;
            map[mission.name] = mission;
        }
        homeRoom._remoteHaulMissionMap = map;
        homeRoom._remoteHaulMissionMapTick = Game.time;
    }
    return homeRoom._remoteHaulMissionMap[missionName] || null;
}

function toRoomPosition(pos) {
    if (!pos) return null;
    if (pos instanceof RoomPosition) return pos;
    if (!pos.roomName) return null;
    const x = Number(pos.x);
    const y = Number(pos.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return new RoomPosition(x, y, pos.roomName);
}

function updateTaskState(creep, resourceType, options) {
    const cfg = options || {};
    const type = resourceType || RESOURCE_ENERGY;
    const requireFull = !!cfg.requireFull;
    const allowPartialWork = !!cfg.allowPartialWork;
    const used = creep.store.getUsedCapacity(type);
    const free = creep.store.getFreeCapacity(type);

    if (creep.memory.taskState === 'working' && used === 0) {
        creep.memory.taskState = 'idle';
    }
    if (creep.memory.taskState === 'gathering' && free === 0) {
        creep.memory.taskState = 'idle';
    }
    if (creep.memory.taskState === 'idle' || creep.memory.taskState === 'init' || !creep.memory.taskState) {
        if (used > 0 && (!requireFull || free === 0 || allowPartialWork)) {
            creep.memory.taskState = 'working';
        } else {
            creep.memory.taskState = 'gathering';
        }
    }
}

function getRoleRuntime(creep) {
    const store = heap.getStore('remoteHaulRole');
    if (!store.creeps) store.creeps = Object.create(null);
    if (!store.creeps[creep.name]) store.creeps[creep.name] = Object.create(null);
    return store.creeps[creep.name];
}

function logOnce(st, sig, message) {
    if (!st || st._lastLogSig === sig) return;
    st._lastLogSig = sig;
    if (typeof debug === 'function') debug('mission.remote.haul', `[RemoteHaulRole] ${message}`);
}

function tryLaneMove(creep, targetPos, range, laneKey, homeRoomName) {
    if (!creep || !targetPos) return false;
    if (!laneKey || !homeRoomName) return false;
    const lane = laneMovement.getOwnedLane(laneKey, homeRoomName);
    if (!lane) return false;

    const prevTask = creep.memory.task;
    creep.memory.task = {
        action: 'move',
        meta: {
            moveMode: 'lane',
            laneKey,
            homeRoom: homeRoomName
        }
    };
    const moved = laneMovement.tryMoveByLane(creep, lane, targetPos, range);
    if (prevTask) creep.memory.task = prevTask;
    else delete creep.memory.task;
    return moved;
}

function moveToPos(creep, targetPos, range, laneKey, homeRoomName) {
    if (!creep || !targetPos) return;
    if (tryLaneMove(creep, targetPos, range, laneKey, homeRoomName)) return;
    borderNav.moveToTarget(creep, targetPos, Number.isFinite(range) ? range : 1);
}

function findFallbackDropoff(creep, resourceType) {
    if (!creep || !creep.room) return null;
    const sinks = [];
    if (creep.room.storage && creep.room.storage.store && creep.room.storage.store.getFreeCapacity(resourceType) > 0) {
        sinks.push(creep.room.storage);
    }
    if (creep.room.terminal && creep.room.terminal.store && creep.room.terminal.store.getFreeCapacity(resourceType) > 0) {
        sinks.push(creep.room.terminal);
    }
    const roomCache = global.getRoomCache(creep.room);
    const mySpawns = roomCache.myStructuresByType[STRUCTURE_SPAWN] || [];
    const myExts = roomCache.myStructuresByType[STRUCTURE_EXTENSION] || [];
    const myTowers = roomCache.myStructuresByType[STRUCTURE_TOWER] || [];
    for (let i = 0; i < mySpawns.length; i++) {
        const s = mySpawns[i];
        if (s && s.store && s.store.getFreeCapacity(resourceType) > 0) sinks.push(s);
    }
    for (let i = 0; i < myExts.length; i++) {
        const s = myExts[i];
        if (s && s.store && s.store.getFreeCapacity(resourceType) > 0) sinks.push(s);
    }
    for (let i = 0; i < myTowers.length; i++) {
        const s = myTowers[i];
        if (s && s.store && s.store.getFreeCapacity(resourceType) > 0) sinks.push(s);
    }

    const containers = creep.room.find(FIND_STRUCTURES, {
        filter: s => s && s.structureType === STRUCTURE_CONTAINER && s.store && s.store.getFreeCapacity(resourceType) > 0
    });
    for (let i = 0; i < containers.length; i++) sinks.push(containers[i]);
    if (sinks.length <= 0) return null;
    return creep.pos.findClosestByRange(sinks);
}

function findPickupByPosition(creep, pickupPos, resourceType) {
    if (!creep || !pickupPos || creep.room.name !== pickupPos.roomName) return null;
    const structs = creep.room.lookForAtArea(
        LOOK_STRUCTURES,
        Math.max(0, pickupPos.y - 1),
        Math.max(0, pickupPos.x - 1),
        Math.min(49, pickupPos.y + 1),
        Math.min(49, pickupPos.x + 1),
        true
    );
    for (let i = 0; i < structs.length; i++) {
        const s = structs[i] && structs[i].structure;
        if (!s || !s.store) continue;
        if ((s.store[resourceType] || 0) <= 0) continue;
        return s;
    }
    return null;
}

function tryOpportunisticPickup(creep, resourceType) {
    if (creep.store.getFreeCapacity(resourceType) <= 0) return false;

    const dropped = creep.room.lookForAt(LOOK_RESOURCES, creep.pos.x, creep.pos.y);
    if (dropped && dropped.length > 0) {
        let target = null;
        let best = 0;
        for (let i = 0; i < dropped.length; i++) {
            const r = dropped[i];
            if (!r || r.resourceType !== resourceType || (r.amount || 0) <= 0) continue;
            if (r.amount > best) {
                best = r.amount;
                target = r;
            }
        }
        if (target) {
            creep.pickup(target);
            return true;
        }
    }

    const tombstones = creep.room.lookForAt(LOOK_TOMBSTONES, creep.pos.x, creep.pos.y);
    if (tombstones && tombstones.length > 0) {
        let target = null;
        let best = 0;
        for (let i = 0; i < tombstones.length; i++) {
            const t = tombstones[i];
            const amt = (t && t.store && t.store[resourceType]) || 0;
            if (amt > best) {
                best = amt;
                target = t;
            }
        }
        if (target) {
            creep.withdraw(target, resourceType);
            return true;
        }
    }

    const ruins = creep.room.lookForAt(LOOK_RUINS, creep.pos.x, creep.pos.y);
    if (ruins && ruins.length > 0) {
        let target = null;
        let best = 0;
        for (let i = 0; i < ruins.length; i++) {
            const r = ruins[i];
            const amt = (r && r.store && r.store[resourceType]) || 0;
            if (amt > best) {
                best = amt;
                target = r;
            }
        }
        if (target) {
            creep.withdraw(target, resourceType);
            return true;
        }
    }

    return false;
}

const roleRemoteHaul = {
    run: function(creep) {
        if (!creep || !creep.memory) return;

        if (creep.memory._travellingToHome) {
            roleUniversal.run(creep);
            return;
        }

        const missionName = creep.memory.missionName;
        if (!missionName) {
            roleUniversal.run(creep);
            return;
        }

        const homeRoomName = creep.memory.room || (creep.room && creep.room.name);
        const homeRoom = homeRoomName ? Game.rooms[homeRoomName] : null;
        const mission = getMissionByName(homeRoom, missionName);
        if (!mission) {
            clearAssignment(creep);
            return;
        }
        if (mission.type !== 'remote_haul') {
            roleUniversal.run(creep);
            return;
        }

        delete creep.memory.task;

        const data = mission.data || {};
        const resourceType = data.resourceType || RESOURCE_ENERGY;
        const pickupPos = toRoomPosition(data.pickupPos);
        const dropoffPos = toRoomPosition(data.dropoffPos);
        const pickupMode = data.pickupMode || 'container';
        const pickupRange = Number.isFinite(data.pickupRange) ? data.pickupRange : 1;
        const remoteRoom = data.remoteRoom || (pickupPos && pickupPos.roomName);
        const laneKeyToPickup = data.laneKeyToPickup || data.laneKey || null;
        const laneKeyToDropoff = data.laneKeyToDropoff || data.laneKey || null;
        const homeRoomKey = data.homeRoom || creep.memory.room || null;
        const st = getRoleRuntime(creep);

        if (remoteRoom && homeRoomKey && creep.room && creep.room.name === remoteRoom) {
            remoteUtils.recordRuntimeThreatIntel(homeRoomKey, creep.room);
        }

        updateTaskState(creep, resourceType, { requireFull: true });
        if (st._lastTaskState !== creep.memory.taskState) {
            st._lastTaskState = creep.memory.taskState;
            logOnce(st, `state:${st._lastTaskState}`, `${creep.name} state=${st._lastTaskState} res=${resourceType}`);
        }

        if (creep.memory.taskState === 'working') {
            if (tryOpportunisticPickup(creep, resourceType)) return;

            const dropoffMoveRange = 1;
            if (dropoffPos && !creep.pos.inRangeTo(dropoffPos, dropoffMoveRange)) {
                logOnce(st, `move:dropoff:${dropoffPos.roomName}`, `${creep.name} move->dropoff ${dropoffPos.roomName} lane=${laneKeyToDropoff || '-'}`);
                moveToPos(creep, dropoffPos, dropoffMoveRange, laneKeyToDropoff, homeRoomKey);
                return;
            }

            let target = data.dropoffId ? Game.getObjectById(data.dropoffId) : null;
            if (!target) {
                const cache = global.getRoomCache(creep.room);
                const storage = (cache.myStructuresByType[STRUCTURE_STORAGE] || [])[0];
                if (storage) target = storage;
                if (!target) {
                    const spawns = cache.myStructuresByType[STRUCTURE_SPAWN] || [];
                    target = creep.pos.findClosestByRange(spawns);
                }
            }

            if (target) {
                if (target.store && target.store.getFreeCapacity(resourceType) === 0) {
                    const fallback = findFallbackDropoff(creep, resourceType);
                    if (fallback) {
                        logOnce(st, `dropoff-fallback:${fallback.id}`, `${creep.name} dropoff fallback -> ${fallback.id} res=${resourceType}`);
                        if (creep.transfer(fallback, resourceType) === ERR_NOT_IN_RANGE) {
                            moveToPos(creep, fallback.pos, 1, laneKeyToDropoff, homeRoomKey);
                        }
                        return;
                    }
                    logOnce(st, `dropoff-full:${target.id}`, `${creep.name} dropoff full target=${target.id}`);
                    moveToPos(creep, target.pos, 1, laneKeyToDropoff, homeRoomKey);
                    return;
                }
                logOnce(st, `transfer:${target.id}`, `${creep.name} transfer -> ${target.id} res=${resourceType}`);
                if (creep.transfer(target, resourceType) === ERR_NOT_IN_RANGE) {
                    moveToPos(creep, target.pos, 1, laneKeyToDropoff, homeRoomKey);
                }
                return;
            }

            const fallback = findFallbackDropoff(creep, resourceType);
            if (fallback) {
                logOnce(st, `dropoff-fallback:${fallback.id}`, `${creep.name} dropoff fallback -> ${fallback.id} res=${resourceType}`);
                if (creep.transfer(fallback, resourceType) === ERR_NOT_IN_RANGE) {
                    moveToPos(creep, fallback.pos, 1, laneKeyToDropoff, homeRoomKey);
                }
                return;
            }
            logOnce(st, 'no-dropoff', `${creep.name} no dropoff target`);
            return;
        }

        if (tryOpportunisticPickup(creep, resourceType)) return;

        if (pickupPos && !creep.pos.inRangeTo(pickupPos, pickupRange)) {
            logOnce(st, `move:pickup:${pickupPos.roomName}`, `${creep.name} move->pickup ${pickupPos.roomName} lane=${laneKeyToPickup || '-'} mode=${pickupMode}`);
            moveToPos(creep, pickupPos, pickupRange, laneKeyToPickup, homeRoomKey);
            return;
        }

        const pickup = data.pickupId ? Game.getObjectById(data.pickupId) : null;
        if (pickup && pickup.store && (pickup.store[resourceType] || 0) > 0) {
            logOnce(st, `withdraw:${pickup.id}`, `${creep.name} withdraw -> ${pickup.id} res=${resourceType}`);
            if (creep.withdraw(pickup, resourceType) === ERR_NOT_IN_RANGE) {
                moveToPos(creep, pickup.pos, pickupRange, laneKeyToPickup, homeRoomKey);
            }
            return;
        }

        const pickupFallback = findPickupByPosition(creep, pickupPos, resourceType);
        if (pickupFallback) {
            logOnce(st, `withdraw:fallback:${pickupFallback.id}`, `${creep.name} withdraw fallback -> ${pickupFallback.id} res=${resourceType}`);
            if (creep.withdraw(pickupFallback, resourceType) === ERR_NOT_IN_RANGE) {
                moveToPos(creep, pickupFallback.pos, 1, laneKeyToPickup, homeRoomKey);
            }
            return;
        }

        const inPickupArea = (pos) => {
            if (!pos) return false;
            if (!pickupPos) return true;
            return pos.inRangeTo(pickupPos, pickupRange);
        };

        const cache = global.getRoomCache(creep.room);
        const tombstone = creep.pos.findClosestByRange(cache.tombstones || [], {
            filter: t => t.store && (t.store[resourceType] || 0) > 0 && inPickupArea(t.pos)
        });
        if (tombstone) {
            logOnce(st, `withdraw:tomb:${tombstone.id}`, `${creep.name} withdraw tombstone -> ${tombstone.id} res=${resourceType}`);
            if (creep.withdraw(tombstone, resourceType) === ERR_NOT_IN_RANGE) {
                moveToPos(creep, tombstone.pos, 1, laneKeyToPickup, homeRoomKey);
            }
            return;
        }

        const dropped = creep.pos.findClosestByRange(cache.dropped || [], {
            filter: r => {
                if (r.resourceType !== resourceType || r.amount <= 0) return false;
                return inPickupArea(r.pos);
            }
        });
        if (dropped) {
            logOnce(st, `pickup:${dropped.id}`, `${creep.name} pickup -> ${dropped.id} res=${resourceType}`);
            if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
                moveToPos(creep, dropped.pos, 1, laneKeyToPickup, homeRoomKey);
            }
            return;
        }

        if (pickupMode === 'drop' && pickupPos) {
            logOnce(st, `wait:pickup:${pickupPos.roomName}`, `${creep.name} wait pickup range=${pickupRange} pos=${pickupPos.roomName}:${pickupPos.x},${pickupPos.y}`);
            moveToPos(creep, pickupPos, pickupRange, laneKeyToPickup, homeRoomKey);
            return;
        }

        logOnce(st, 'no-task', `${creep.name} no task mode=${pickupMode} res=${resourceType}`);
    }
};

module.exports = roleRemoteHaul;
