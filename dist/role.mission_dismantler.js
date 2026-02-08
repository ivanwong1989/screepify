var roleMissionDismantler = {

    /** @param {Creep} creep **/
    run: function(creep) {
        var flag = Game.flags['FlagDismantle'];
        if (flag) {
            creep.memory.targetRoom = flag.pos.roomName;
        }

        // Check if target room memory is created, if not, create it with initial NA
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
            log("Dismantler just arrived");
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

        // Move to target room logic. 
        if (creep.room.name !== creep.memory.targetRoom && creep.memory.targetRoom!= "NA") {
            const targetPos = new RoomPosition(flag.pos.x, flag.pos.y, creep.memory.targetRoom);
            creep.moveTo(targetPos, {visualizePathStyle: {stroke: '#ffaa00'}, range: 1});
        } else if (creep.room.name == creep.memory.targetRoom) {
            // Creep is already at target room.
            var target = null;
            if (flag) {
                var structures = flag.pos.lookFor(LOOK_STRUCTURES);
                target = structures.find(s => s.structureType != STRUCTURE_CONTROLLER);
                if (!target) {
                    creep.moveTo(flag, {visualizePathStyle: {stroke: '#ffffff'}, range: 1});
                }
            } else {
                // Just move to the flag
                creep.moveTo(flag, {visualizePathStyle: {stroke: '#ff0000'}, range: 1});
            }
            
            if (target) {
                if (creep.dismantle(target) == ERR_NOT_IN_RANGE) {
                    creep.moveTo(target, {visualizePathStyle: {stroke: '#ff0000'}, range: 1});
                }
            }
        }
    }
};

module.exports = roleMissionDismantler;
