var roleMissionReserver = {

    /** @param {Creep} creep **/
    run: function(creep) {
        // Check if reserver target room memory is created, if not, create it with initial NA
        if (!creep.memory.targetRoom) {
            creep.memory.targetRoom = "NA";          
        }

        // If we just entered a new room, step off the exit first
        const currentRoom = creep.room;

        // Update Memory.remoteRooms with info on available sources and positions
        if (!Memory.remoteRooms) Memory.remoteRooms = {};
        if (!Memory.remoteRooms[currentRoom.name] || Game.time - Memory.remoteRooms[currentRoom.name].lastScouted > 1000) {
            const sources = currentRoom.find(FIND_SOURCES);
            const sourceIds = sources.map(s => s.id);
            const sourcePositions = sources.map(s => ({x: s.pos.x, y: s.pos.y}));

            const controller = currentRoom.controller;
            const hostileCreeps = currentRoom.find(FIND_HOSTILE_CREEPS).filter(c => 
                c.getActiveBodyparts(ATTACK) > 0 || c.getActiveBodyparts(RANGED_ATTACK) > 0
            );
            const towers = currentRoom.find(FIND_HOSTILE_STRUCTURES, {
                filter: (s) => s.structureType == STRUCTURE_TOWER
            });

            const isHostile = (controller && controller.owner && !controller.my) || 
                              (hostileCreeps.length > 0) ||
                              (towers.length > 0);
            
            Memory.remoteRooms[currentRoom.name] = {
                sources: sourceIds,
                sourcePositions: sourcePositions,
                lastScouted: Game.time,
                hostile: isHostile,
                sourceCount: sources.length
            };
        }

        const onExit = creep.pos.x === 0 || creep.pos.x === 49 || creep.pos.y === 0 || creep.pos.y === 49;
        if (creep.memory.currentRoom !== currentRoom.name) {
            creep.memory.currentRoom = currentRoom.name;
            creep.memory.justArrived = true;
        }

        if (creep.memory.justArrived) {
            log("Reserver just arrived");
            if (onExit) {
                log("Reserver is on exit, moving");
                if (creep.pos.x === 0) creep.move(RIGHT);
                else if (creep.pos.x === 49) creep.move(LEFT);
                else if (creep.pos.y === 0) creep.move(BOTTOM);
                else if (creep.pos.y === 49) creep.move(TOP);
                else creep.moveTo(new RoomPosition(25, 25, currentRoom.name), {reusePath: 10, maxRooms: 1, range: 1});
                return;
            } else {
                creep.memory.justArrived = false;
            }
        }

        // Move to target room logic. 
        if (creep.room.name !== creep.memory.targetRoom && creep.memory.targetRoom!= "NA") {
            const targetPos = new RoomPosition(25, 25, creep.memory.targetRoom);
            creep.moveTo(targetPos, {reusePath: 50, range: 1});
        } else if (creep.room.name == creep.memory.targetRoom) {
            // Creep is already at target room. Now look for the controller in the room.
            if (creep.room.controller) {
                // If controller is owned by someone else, or reserved by someone else, attack it
                // Note: .owner is undefined for neutral controllers
                var isEnemy = (creep.room.controller.owner && !creep.room.controller.my) ||
                              (creep.room.controller.reservation && creep.room.controller.reservation.username != creep.owner.username);

                if (isEnemy) {
                    // Controller not owned/reserved by me, attack it instead
                    if (creep.attackController(creep.room.controller) == ERR_NOT_IN_RANGE) {
                        creep.moveTo(creep.room.controller, {reusePath: 15, range: 1});
                    }
                } else {
                    // Controller is neutral or reserved by me, reserve it.
                    if (creep.reserveController(creep.room.controller) == ERR_NOT_IN_RANGE) {
                        creep.moveTo(creep.room.controller, {reusePath: 15, range: 1});
                    }
                }
            }
        }
    }
};

module.exports = roleMissionReserver;
