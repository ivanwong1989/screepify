var roleMissionHaulerInterRoom = {

    /** @param {Creep} creep **/
    run: function(creep) {
        // State switching
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

        var mission = Memory.missionControl.squads.movinghouse;
        var bankRoom = mission ? mission.targetRoomBank : null;
        var sinkRoom = mission ? mission.targetRoomSink : null;
        var sinkPos = null;
        if (mission && mission.sinkPos) {
            sinkPos = new RoomPosition(mission.sinkPos.x, mission.sinkPos.y, mission.sinkPos.roomName);
        }

        if (creep.memory.working) {
            // STATE: DELIVERING (to FlagSink)
            if (sinkRoom && creep.room.name !== sinkRoom) {
                let targetPos = sinkPos || new RoomPosition(25, 25, sinkRoom);
                creep.moveTo(targetPos, {visualizePathStyle: {stroke: '#00ff00'}, reusePath: 20, range: 1});
            } else if (sinkRoom) {
                // We are at Sink room, find a place to dump energy
                
                // 0. Give to Bootstrap Creeps
                var bootstrap = creep.pos.findClosestByPath(FIND_MY_CREEPS, {
                    filter: (c) => c.memory.role == 'mission_bootstrap' && 
                                   c.store.getFreeCapacity(RESOURCE_ENERGY) > 0 &&
                                   !c.memory.working &&
                                   (!sinkPos || c.pos.inRangeTo(sinkPos, 5))
                });
                if (bootstrap) {
                    if (creep.transfer(bootstrap, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                        creep.moveTo(bootstrap, {visualizePathStyle: {stroke: '#ffffff'}, range: 1});
                    }
                    return;
                }

                // 0. Give to Builder Creeps
                var builder = creep.pos.findClosestByPath(FIND_MY_CREEPS, {
                    filter: (c) => c.memory.role == 'builder' && 
                                   c.store.getFreeCapacity(RESOURCE_ENERGY) > 0 &&
                                   !c.memory.building &&
                                   (!sinkPos || c.pos.inRangeTo(sinkPos, 5))
                });
                if (builder) {
                    if (creep.transfer(builder, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                        creep.moveTo(builder, {visualizePathStyle: {stroke: '#ffffff'}, range: 1});
                    }
                    return;
                }

                // Priority: Storage/Containers/Spawn
                var target = creep.pos.findClosestByPath(FIND_STRUCTURES, {
                    filter: (s) => (s.structureType == STRUCTURE_STORAGE || s.structureType == STRUCTURE_SPAWN) &&
                                   s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
                });

                if (target) {
                    if (creep.transfer(target, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                        creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}, range: 1});
                    }
                }

                if (!target) {
                    // No targets, move to flag to uncongest the entrance
                    creep.moveTo(sinkPos, {visualizePathStyle: {stroke: '#ffffff'}, range: 1});
                }
            }
        } else {
            // STATE: FETCHING (from FlagBank)
            if (bankRoom && creep.room.name !== bankRoom) {
                creep.moveTo(new RoomPosition(25, 25, bankRoom), {visualizePathStyle: {stroke: '#ffaa00'}, reusePath: 20, range: 1});
            } else if (bankRoom) {
                // We are in the Bank room
                let target = null;
                
                // 1. Try Storage
                if (creep.room.storage && creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                    target = creep.room.storage;
                }
                
                // 2. Fallback to Containers if Storage is empty or missing
                if (!target) {
                    target = creep.pos.findClosestByPath(FIND_STRUCTURES, {
                        filter: (s) => s.structureType == STRUCTURE_CONTAINER &&
                                       s.store.getUsedCapacity(RESOURCE_ENERGY) > 0
                    });
                }

                if (target) {
                    if (creep.withdraw(target, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                        creep.moveTo(target, {visualizePathStyle: {stroke: '#ffaa00'}, range: 1});
                    }
                } else {
                    creep.say('No Energy');
                }
            }
        }
    }
};

module.exports = roleMissionHaulerInterRoom;
