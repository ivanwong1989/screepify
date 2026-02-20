const helpers = require('managers_overseer_tasks_exec__helpers');
const execGatherTask = require('managers_overseer_tasks_exec_gather');

module.exports = function execRemoteEnergyGatherTask(ctx) {
    const { creep, homeRoom, homeRoomName, remoteRoomName, targetPos, opts } = ctx;
    const REMOTE_GATHER_RANGE = 20;
    const REMOTE_STICKY_TICKS = 25;
    const REMOTE_HOME_STICKY_TICKS = 40;
    const now = Game.time;

    if (creep.memory._remoteEnergy && creep.memory._remoteEnergy.until && creep.memory._remoteEnergy.until < now) {
        delete creep.memory._remoteEnergy;
    }

    const inRemoteRoom = remoteRoomName && creep.room.name === remoteRoomName;
    const memory = creep.memory._remoteEnergy;

    if (inRemoteRoom) {
        if (memory && memory.mode === 'home' && memory.until && memory.until >= now) {
            // stick to home decision
        } else {
            if (memory && memory.mode === 'remote' && memory.targetId && memory.roomName === creep.room.name &&
                memory.until && memory.until >= now) {
                const stickyTarget = Game.getObjectById(memory.targetId);
                if (stickyTarget) {
                    if (memory.action === 'harvest') {
                        if (creep.getActiveBodyparts(WORK) > 0 &&
                            stickyTarget.energy > 0 &&
                            helpers.hasFreeHarvestSpot(creep, stickyTarget)) {
                            return { type: 'harvest', targetId: stickyTarget.id };
                        }
                    } else if (memory.action === 'withdraw') {
                        if (stickyTarget.store && (stickyTarget.store[RESOURCE_ENERGY] || 0) > 0) {
                            return { type: 'withdraw', targetId: stickyTarget.id, resourceType: RESOURCE_ENERGY };
                        }
                    }
                }
            }

            const tryHarvest = () => {
                if (creep.getActiveBodyparts(WORK) === 0) return null;
                const cache = global.getRoomCache(creep.room);
                const sources = cache.sourcesActive || creep.room.find(FIND_SOURCES_ACTIVE);
                const nearbySources = sources.filter(s =>
                    creep.pos.getRangeTo(s.pos) <= REMOTE_GATHER_RANGE &&
                    helpers.hasFreeHarvestSpot(creep, s)
                );
                const source = creep.pos.findClosestByRange(nearbySources);
                if (source) {
                    creep.memory._remoteEnergy = {
                        mode: 'remote',
                        action: 'harvest',
                        targetId: source.id,
                        roomName: creep.room.name,
                        until: now + REMOTE_STICKY_TICKS
                    };
                    return { type: 'harvest', targetId: source.id };
                }
                return null;
            };

            const tryWithdraw = () => {
                const cache = global.getRoomCache(creep.room);
                const containers = (cache.structuresByType[STRUCTURE_CONTAINER] || []);
                const storages = (cache.structuresByType[STRUCTURE_STORAGE] || []);
                const candidates = containers.concat(storages).filter(c =>
                    (c.store[RESOURCE_ENERGY] || 0) > 0 &&
                    creep.pos.getRangeTo(c.pos) <= REMOTE_GATHER_RANGE
                );
                
                const target = creep.pos.findClosestByRange(candidates);
                if (target) {
                    creep.memory._remoteEnergy = {
                        mode: 'remote',
                        action: 'withdraw',
                        targetId: target.id,
                        roomName: creep.room.name,
                        until: now + REMOTE_STICKY_TICKS
                    };
                    return { type: 'withdraw', targetId: target.id, resourceType: RESOURCE_ENERGY };
                }
                return null;
            };

            if (opts && opts.prioritizeWithdraw) {
                const result = tryWithdraw() || tryHarvest();
                if (result) return result;
            } else {
                const result = tryHarvest() || tryWithdraw();
                if (result) return result;
            }

            creep.memory._remoteEnergy = {
                mode: 'home',
                roomName: homeRoomName,
                until: now + REMOTE_HOME_STICKY_TICKS
            };
        }
    }

    if (homeRoomName && creep.room.name !== homeRoomName) {
        const anchor = homeRoom && homeRoom.storage ? homeRoom.storage.pos
            : (homeRoom && homeRoom.controller ? homeRoom.controller.pos : null);
        const movePos = anchor || { x: 25, y: 25, roomName: homeRoomName };
        return { type: 'move', targetPos: { x: movePos.x, y: movePos.y, roomName: movePos.roomName }, range: 3 };
    }

    const gatherRoom = homeRoom || creep.room;
    const task = execGatherTask({ creep, room: gatherRoom, options: {} });
    if (task) return task;
    if (targetPos && creep.room.name !== targetPos.roomName) {
        return { type: 'move', targetPos: { x: targetPos.x, y: targetPos.y, roomName: targetPos.roomName }, range: 1 };
    }
    return null;
};
