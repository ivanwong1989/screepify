var roleMissionClaimer = {

    /** @param {Creep} creep **/
    run: function(creep) {
        // Check if claimer target room memory is created, if not, create it with initial NA
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
            log("Claimer just arrived");
            if (onExit) {
                log("Claimer is on exit, moving");
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
                        creep.moveTo(creep.room.controller, {visualizePathStyle: {stroke: '#ff0000'}, range: 1});
                    }
                } else {
                    // Controller is neutral or reserved by me, claim it.
                    if (creep.claimController(creep.room.controller) == ERR_NOT_IN_RANGE) {
                        creep.moveTo(creep.room.controller, {visualizePathStyle: {stroke: '#ffffff'}, range: 1});
                    }
                }
            }
        }
    }
};

module.exports = roleMissionClaimer;
