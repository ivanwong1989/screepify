var roleDrainer = {

    /** @param {Creep} creep **/
    run: function(creep) {
        const flag = Game.flags['FlagDrainer'];

        // 1. Fallback: If the flag is gone, head back to homeRoom spawn
        if (!flag) {
            let homeRoom = Game.rooms[creep.memory.homeRoom];
            if (homeRoom) {
                let spawn = homeRoom.find(FIND_MY_SPAWNS)[0];
                if (spawn) {
                    if (!creep.pos.inRangeTo(spawn, 5)) {
                        creep.moveTo(spawn, { range: 5, visualizePathStyle: { stroke: '#ffffff' } });
                    }
                }
            }
            if (creep.hits < creep.hitsMax) creep.heal(creep);
            return;
        }

        // 2. Self-Heal: Always heal if damaged
        if (creep.hits < creep.hitsMax) {
            creep.heal(creep);
        }

        const targetRoomName = flag.pos.roomName;
        const onExit = creep.pos.x === 0 || creep.pos.x === 49 || creep.pos.y === 0 || creep.pos.y === 49;

        // 3. Movement Logic
        if (creep.room.name === targetRoomName) {
            // INSIDE TARGET ROOM
            if (onExit) {
                // Just entered: move one tile out of the exit
                creep.moveTo(new RoomPosition(25, 25, targetRoomName), { range: 23 });
                creep.say('Entering');
            } else {
                // Already inside: step back out to the adjacent room we came from
                if (creep.memory.adjacentRoom) {
                    const exitPos = new RoomPosition(25, 25, creep.memory.adjacentRoom);
                    creep.moveTo(exitPos, { visualizePathStyle: { stroke: '#ff0000' }, range: 1 });
                    creep.say('Exiting');
                }
            }
        } else {
            // OUTSIDE TARGET ROOM (Adjacent/Safe Room)
            creep.memory.adjacentRoom = creep.room.name; // Mark this as the safe room to return to

            if (creep.hits === creep.hitsMax) {
                // Fully healed: Head back into the target room
                creep.moveTo(flag, { visualizePathStyle: { stroke: '#00ff00' }, range: 1 });
                creep.say('To Target');
            } else {
                // Still healing: Step off the exit if we just arrived back
                if (onExit) {
                    creep.moveTo(new RoomPosition(25, 25, creep.room.name), { range: 23 });
                }
                creep.say('Healing');
            }
        }
    }
};

module.exports = roleDrainer;
