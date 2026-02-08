var roleMissionBootstrap = {

    /** @param {Creep} creep **/
    run: function(creep) {
        // State switching
        if (creep.memory.working && creep.store.getUsedCapacity() === 0) {
            creep.memory.working = false;
            creep.say('🔄 harvest');
        }
        if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
            creep.memory.working = true;
            creep.say('🚧 build');
        }

        // Check if target room memory is created
        if (!creep.memory.targetRoom) {
            creep.memory.targetRoom = "NA";          
        }

        // If we just entered a new room, step off the exit first
        const currentRoom = creep.room;
        const onExit = creep.pos.x === 0 || creep.pos.x === 49 || creep.pos.y === 0 || creep.pos.y === 49;
        if (creep.memory.currentRoom !== currentRoom.name) {
            creep.memory.currentRoom = currentRoom.name;
            creep.memory.justArrived = true;
        }

        if (creep.memory.justArrived) {
            log("Bootstrap just arrived");
            if (onExit) {
                log("Bootstrap is on exit, moving");
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

        // Move to target room logic. 
        if (creep.room.name !== creep.memory.targetRoom && creep.memory.targetRoom!= "NA") {
            const targetPos = new RoomPosition(25, 25, creep.memory.targetRoom);
            creep.moveTo(targetPos, {visualizePathStyle: {stroke: '#ffaa00'}, range: 1});
        } 
        else if (creep.room.name == creep.memory.targetRoom) {
            // We are in the target room
            if (creep.memory.working) {
                // Priority: Build Spawn
                var spawnSite = creep.room.find(FIND_MY_CONSTRUCTION_SITES, {
                    filter: (s) => s.structureType == STRUCTURE_SPAWN
                })[0];

                if (spawnSite) {
                    if (creep.build(spawnSite) == ERR_NOT_IN_RANGE) {
                        creep.moveTo(spawnSite, {visualizePathStyle: {stroke: '#ffffff'}, range: 1});
                    }
                } else {
                    // Fallback: Build other things or Upgrade
                    var target = creep.pos.findClosestByPath(FIND_CONSTRUCTION_SITES);
                    if (target) {
                        if (creep.build(target) == ERR_NOT_IN_RANGE) {
                            creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}, range: 1});
                        }
                    } else {
                        if (creep.upgradeController(creep.room.controller) == ERR_NOT_IN_RANGE) {
                            creep.moveTo(creep.room.controller, {visualizePathStyle: {stroke: '#ffffff'}, range: 1});
                        }
                    }
                }
            } else {
                // Harvest or Get from Hauler
                var hauler = creep.pos.findClosestByPath(FIND_MY_CREEPS, {
                    filter: (c) => c.memory.role == 'mission_hauler_interroom' && c.store.getUsedCapacity(RESOURCE_ENERGY) > 0
                });

                if (hauler) {
                    if (creep.pos.getRangeTo(hauler) > 1) {
                        creep.moveTo(hauler, {visualizePathStyle: {stroke: '#ffaa00'}, range: 1});
                    }
                } else {
                    var source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
                    if (source) {
                        if (creep.harvest(source) == ERR_NOT_IN_RANGE) {
                            creep.moveTo(source, {visualizePathStyle: {stroke: '#ffaa00'}, range: 1});
                        }
                    }
                }
            }
        }
    }
};

module.exports = roleMissionBootstrap;
