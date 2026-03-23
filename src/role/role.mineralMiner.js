const borderNav = require('utils_creepBorderNav');
const roleUniversal = require('role_role.universal');
const movement = require('utils_movement');
const heap = require('utils_heap');

const MINERAL_MINER_HEAP_STORE = 'roleMineralMiner';

function clearMineralAssignment(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.missionName;
    delete creep.memory.task;
    delete creep.memory.taskState;
    delete creep.memory._trafficMove;
}

function getRoomCache(room) {
    if (!room || typeof global.getRoomCache !== 'function') return null;
    return global.getRoomCache(room);
}

function getMineralRoomMemo(room, roomCache) {
    if (!room) return null;
    const store = heap.getStore(MINERAL_MINER_HEAP_STORE, { ttl: 50 });
    const existing = store[room.name];
    if (existing && existing.time === Game.time) return existing;

    const occupancy = Object.create(null);
    const creeps = (roomCache && Array.isArray(roomCache.creeps))
        ? roomCache.creeps
        : room.find(FIND_CREEPS);
    for (let i = 0; i < creeps.length; i++) {
        const c = creeps[i];
        if (!c || !c.pos) continue;
        occupancy[`${c.pos.x}:${c.pos.y}`] = (occupancy[`${c.pos.x}:${c.pos.y}`] || 0) + 1;
    }

    const memo = {
        time: Game.time,
        idObj: Object.create(null),
        occupancyByTile: occupancy
    };
    store[room.name] = memo;
    return memo;
}

function getObjectByIdCached(memo, id) {
    if (!id) return null;
    if (!memo) return Game.getObjectById(id);
    if (memo.idObj[id] === undefined) memo.idObj[id] = Game.getObjectById(id) || null;
    return memo.idObj[id];
}

function isTileFreeForCreep(pos, creep, memo) {
    if (!pos || !creep || !creep.pos || !memo || !memo.occupancyByTile) return true;
    const occupied = memo.occupancyByTile[`${pos.x}:${pos.y}`] || 0;
    if (occupied <= 0) return true;
    if (creep.pos.isEqualTo(pos)) return occupied <= 1;
    return false;
}

function moveMineralTo(creep, target, range, useTraffic) {
    if (!creep || !target) return;
    const desiredRange = Number.isFinite(range) ? range : 1;
    if (useTraffic) {
        movement.planMoveTo(creep, target, {
            range: desiredRange,
            maxRooms: 1
        });
        return;
    }
    borderNav.moveToTarget(creep, target, desiredRange);
}

function getFirstCarriedType(creep, preferredType) {
    if (!creep || !creep.store || (creep.store.getUsedCapacity() || 0) <= 0) return null;
    if (preferredType && (creep.store[preferredType] || 0) > 0) return preferredType;
    for (const type in creep.store) {
        if ((creep.store[type] || 0) > 0) return type;
    }
    return null;
}

function getMissionByName(homeRoom, missionName) {
    if (!homeRoom || !missionName) return null;
    if (homeRoom._mineralMissionMapTick !== Game.time || !homeRoom._mineralMissionMap) {
        const map = Object.create(null);
        const missions = Array.isArray(homeRoom._missions) ? homeRoom._missions : [];
        for (let i = 0; i < missions.length; i++) {
            const mission = missions[i];
            if (!mission || !mission.name) continue;
            map[mission.name] = mission;
        }
        homeRoom._mineralMissionMap = map;
        homeRoom._mineralMissionMapTick = Game.time;
    }
    return homeRoom._mineralMissionMap[missionName] || null;
}

function transferOrMove(creep, target, resourceType, range, useTraffic) {
    if (!creep || !target) return;
    const code = creep.transfer(target, resourceType);
    if (code === ERR_NOT_IN_RANGE) {
        moveMineralTo(creep, target, range, useTraffic);
    }
}

const roleMineralMiner = {
    run: function(creep) {
        if (!creep || !creep.memory) return;

        if (creep.memory._travellingToHome) {
            roleUniversal.run(creep);
            return;
        }

        const missionName = creep.memory.missionName;
        if (!missionName) {
            movement.enableTrafficBlockerOnlyAtCurrentPos(creep);
            roleUniversal.run(creep);
            return;
        }

        const homeRoomName = creep.memory.room || (creep.room && creep.room.name);
        const homeRoom = homeRoomName ? Game.rooms[homeRoomName] : null;
        const mission = getMissionByName(homeRoom, missionName);
        if (!mission) {
            clearMineralAssignment(creep);
            movement.enableTrafficBlockerOnlyAtCurrentPos(creep);
            return;
        }

        if (mission.type !== 'mineral') {
            movement.enableTrafficBlockerOnlyAtCurrentPos(creep);
            roleUniversal.run(creep);
            return;
        }

        const useTraffic = true;
        if (useTraffic) {
            movement.enableTrafficForBuildWorker(creep);
        }

        delete creep.memory.task;
        delete creep.memory.taskState;

        const roomCache = getRoomCache(creep.room);
        const memo = getMineralRoomMemo(creep.room, roomCache);
        const mineralId = mission.mineralId || mission.targetId;
        const mineral = mineralId ? getObjectByIdCached(memo, mineralId) : null;
        if (!mineral || (mineral.mineralAmount || 0) <= 0) {
            clearMineralAssignment(creep);
            return;
        }

        const missionData = mission.data || {};
        if (missionData.extractorId) {
            const extractor = getObjectByIdCached(memo, missionData.extractorId);
            if (!extractor) {
                clearMineralAssignment(creep);
                return;
            }
        }

        const resourceType = missionData.resourceType || mineral.mineralType;
        const container = missionData.containerId ? getObjectByIdCached(memo, missionData.containerId) : null;
        const terminal = creep.room && creep.room.terminal ? creep.room.terminal : null;
        const storage = creep.room && creep.room.storage ? creep.room.storage : null;

        const depositType = getFirstCarriedType(creep, resourceType);
        if (depositType) {
            const terminalHasSpace = terminal && terminal.store && (terminal.store.getFreeCapacity(depositType) || 0) > 0;
            const storageHasSpace = storage && storage.store && (storage.store.getFreeCapacity(depositType) || 0) > 0;
            const containerHasSpace = container && container.store && (container.store.getFreeCapacity(depositType) || 0) > 0;
            const depositTarget = terminalHasSpace
                ? terminal
                : (storageHasSpace ? storage : (containerHasSpace ? container : null));

            if (depositTarget === container && creep.pos.inRangeTo(container.pos, 1)) {
                transferOrMove(creep, container, depositType, 1, useTraffic);
                return;
            }

            if (creep.store.getFreeCapacity() === 0) {
                if (depositTarget) {
                    if (depositTarget === container) {
                        if (creep.pos.inRangeTo(container.pos, 1)) {
                            transferOrMove(creep, container, depositType, 1, useTraffic);
                        } else {
                            moveMineralTo(creep, container, 0, useTraffic);
                        }
                        return;
                    }

                    transferOrMove(creep, depositTarget, depositType, 1, useTraffic);
                    return;
                }

                creep.drop(depositType);
                return;
            }
        }

        if (container && !creep.pos.isEqualTo(container.pos)) {
            if (isTileFreeForCreep(container.pos, creep, memo)) {
                moveMineralTo(creep, container, 0, useTraffic);
                return;
            }
        }

        const harvestCode = creep.harvest(mineral);
        if (harvestCode === ERR_NOT_IN_RANGE) {
            moveMineralTo(creep, mineral, 1, useTraffic);
        }
    }
};

module.exports = roleMineralMiner;
