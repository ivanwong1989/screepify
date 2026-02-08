var roleRemoteHarvester = {

    /** @param {Creep} creep **/
    run: function(creep) {
        // State switching
        if (creep.memory.working && creep.store.getUsedCapacity() === 0) {
            creep.memory.working = false;
            creep.say('🔄 harvest');
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
            log("RHarvester just arrived");
            if (onExit) {
                log("RHarvester is on exit, moving");
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
            // If not in home room, move there
            if (creep.room.name !== creep.memory.homeRoom) {
                const homePos = new RoomPosition(25, 25, creep.memory.homeRoom);
                creep.moveTo(homePos, {visualizePathStyle: {stroke: '#00ff00'}, range: 1});
            } else {
                // We are home, find a place to dump energy
                var target = creep.pos.findClosestByPath(FIND_STRUCTURES, {
                    filter: (s) => (s.structureType == STRUCTURE_STORAGE || 
                                    s.structureType == STRUCTURE_CONTAINER ||
                                    s.structureType == STRUCTURE_EXTENSION ||
                                    s.structureType == STRUCTURE_SPAWN) &&
                                   s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
                });
                if (target) {
                    if (creep.transfer(target, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                        creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}, maxRooms: 1, range: 1});
                    }
                }
            }
        } else {
            // STATE: HARVESTING
            // If not in target room, move there
            if (creep.room.name !== creep.memory.targetRoom) {
                const targetPos = new RoomPosition(25, 25, creep.memory.targetRoom);
                creep.moveTo(targetPos, {visualizePathStyle: {stroke: '#ffaa00'}, range: 1});
            } else {
                // We are in the target room, find the specific source
                let source = Game.getObjectById(creep.memory.targetSourceId);
                
                if (source) {
                    const harvestResult = creep.harvest(source);
                    if (harvestResult == ERR_NOT_IN_RANGE) {
                        creep.moveTo(source, {visualizePathStyle: {stroke: '#ffaa00'}, maxRooms: 1, range: 1});
                    } else if (harvestResult == ERR_NOT_ENOUGH_RESOURCES) {
                        creep.say('Empty');
                    } else if (harvestResult !== OK) {
                        log(`[${creep.name}] Harvest error: ${harvestResult}`);
                    }
                } else {
                    log(`[${creep.name}] Source ${creep.memory.targetSourceId} not found in room ${creep.room.name}`);
                }
            }
        }
    }
};

module.exports = roleRemoteHarvester;
