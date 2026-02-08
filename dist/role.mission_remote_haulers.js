var roleMissionRemoteHauler = {
    run: function(creep) {
        const cache = global.getRoomCache(creep.room);
        if (creep.memory.working && creep.store.getUsedCapacity() === 0) {
            creep.memory.working = false;
            creep.say('🔄 fetch');
        }
        if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
            creep.memory.working = true;
            creep.say('🚚 deliver');
        }

        // If we just entered a new room, step off the exit first
        const currentRoom = creep.room;
        const onExit = creep.pos.x === 0 || creep.pos.x === 49 || creep.pos.y === 0 || creep.pos.y === 49;
        if (creep.memory.currentRoom !== currentRoom.name) {
            creep.memory.currentRoom = currentRoom.name;
            creep.memory.justArrived = true;
        }

        if (creep.memory.justArrived) {
            if (onExit) {
                if (creep.pos.x === 0) creep.move(RIGHT);
                else if (creep.pos.x === 49) creep.move(LEFT);
                else if (creep.pos.y === 0) creep.move(BOTTOM);
                else if (creep.pos.y === 49) creep.move(TOP);
                else creep.moveTo(new RoomPosition(25, 25, currentRoom.name), {visualizePathStyle: {stroke: '#ffffff'}, reusePath: 0, maxRooms: 1, range: 1});
                return;
            } else {
                creep.memory.justArrived = false;
            }
        }

        if (creep.memory.working) {
            // STATE: DELIVERING
            if (creep.room.name !== creep.memory.homeRoom) {
                const homeRoom = Game.rooms[creep.memory.homeRoom];
                let targetPos = new RoomPosition(25, 25, creep.memory.homeRoom);
                if (homeRoom && homeRoom.storage) {
                    targetPos = homeRoom.storage.pos;
                }
                creep.moveTo(targetPos, {visualizePathStyle: {stroke: '#00ff00'}, reusePath: 20, range: 1});
            } else {
                // We are home, find a place to dump energy
                var target = creep.room.storage;

                if (!target || target.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
                    let targets = [];
                    if (cache.structuresByType[STRUCTURE_EXTENSION]) targets.push(...cache.structuresByType[STRUCTURE_EXTENSION]);
                    if (cache.structuresByType[STRUCTURE_SPAWN]) targets.push(...cache.structuresByType[STRUCTURE_SPAWN]);

                    target = creep.pos.findClosestByPath(targets, {
                        filter: (s) => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
                    });
                }

                if (target) {
                    if (creep.transfer(target, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                        creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}, maxRooms: 1, range: 1});
                    }
                }
            }
        } else {
            // STATE: FETCHING
            if (creep.room.name !== creep.memory.targetRoom) {
                let targetPos = new RoomPosition(25, 25, creep.memory.targetRoom);

                if (Memory.remoteRooms && Memory.remoteRooms[creep.memory.targetRoom]) {
                    const rMem = Memory.remoteRooms[creep.memory.targetRoom];
                    if (rMem.sources && rMem.sourcePositions) {
                        const idx = rMem.sources.indexOf(creep.memory.targetSourceId);
                        if (idx !== -1 && rMem.sourcePositions[idx]) {
                            targetPos = new RoomPosition(rMem.sourcePositions[idx].x, rMem.sourcePositions[idx].y, creep.memory.targetRoom);
                        }
                    }
                }

                creep.moveTo(targetPos, {visualizePathStyle: {stroke: '#ffaa00'}, reusePath: 20, range: 1});
            } else {
                // We are in the target room, find the specific source and look for energy
                let source = Game.getObjectById(creep.memory.targetSourceId);
                
                if (source) {
                    // 1. Dropped Resources
                    const dropped = (cache.dropped || []).find(r => r.resourceType == RESOURCE_ENERGY && r.pos.inRangeTo(source, 5));
                    if (dropped) {
                        if (creep.pickup(dropped) == ERR_NOT_IN_RANGE) {
                            creep.moveTo(dropped, {visualizePathStyle: {stroke: '#ffaa00'}, maxRooms: 1, range: 1});
                        }
                        return;
                    }

                    // 2. Container
                    const containers = cache.structuresByType[STRUCTURE_CONTAINER] || [];
                    const container = containers.find(s => s.pos.inRangeTo(source, 2));

                    if (container && container.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                        if (creep.withdraw(container, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                            creep.moveTo(container, {visualizePathStyle: {stroke: '#ffaa00'}, maxRooms: 1, range: 1});
                        }
                    } else {
                        // Wait near source
                        if (!creep.pos.inRangeTo(source, 3)) {
                            creep.moveTo(source, {range: 3, visualizePathStyle: {stroke: '#ffaa00'}, maxRooms: 1});
                        }
                    }
                }
            }
        }
    }
};

module.exports = roleMissionRemoteHauler;
