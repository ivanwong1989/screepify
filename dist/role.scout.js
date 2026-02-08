var roleScout = {

    /** @param {Creep} creep **/
    run: function(creep) {
        // 1. Scan the current room and update Memory
        // We use a global Memory object 'remoteRooms' to store our intel
        if (!Memory.remoteRooms) Memory.remoteRooms = {};
        
        const currentRoom = creep.room;
        log(`Scout ${creep.name} scanned room ${currentRoom.name}`);

        // If we just entered a new room, step off the exit first
        const onExit = creep.pos.x === 0 || creep.pos.x === 49 || creep.pos.y === 0 || creep.pos.y === 49;
        if (creep.memory.currentRoom !== currentRoom.name) {
            creep.memory.currentRoom = currentRoom.name;
            creep.memory.justArrived = true;
        }

        if (creep.memory.justArrived) {
            log("Scout just arrived");
            if (onExit) {
                log("Scout is on exit, moving");
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

        // Update data if it's missing or older than 1000 ticks
        if (!Memory.remoteRooms[currentRoom.name] || Game.time - Memory.remoteRooms[currentRoom.name].lastScouted > 1000) {
            const sources = currentRoom.find(FIND_SOURCES);
            const sourceIds = sources.map(s => s.id);
            const sourcePositions = sources.map(s => ({x: s.pos.x, y: s.pos.y}));
            const controller = currentRoom.controller;
            
            // Determine if the room is dangerous (owned by someone else or has bad guys)
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
            };
            log(`Scout ${creep.name} scanned room ${currentRoom.name}: ${sources.length} sources, Hostile: ${isHostile}`);
        }

        // 2. Decide where to go next
        // If we don't have a target, or we are already at the target, pick a new random exit
        if (!creep.memory.targetRoom || creep.room.name === creep.memory.targetRoom) {
            log(`Scout ${creep.name} scanned room ${currentRoom.name} target room ${creep.memory.targetRoom}`);
            const exits = Game.map.describeExits(currentRoom.name);
            const allExits = [];
            for (const exitDir in exits) {
                if (creep.pos.findClosestByPath(Number(exitDir))) {
                    allExits.push(exits[exitDir]);
                }
            }

            // Initialize visited list if it doesn't exist
            if (!creep.memory.visited) creep.memory.visited = [];

            // Record current room to visited list
            creep.memory.visited.push(currentRoom.name);
            if (creep.memory.visited.length > 10) creep.memory.visited.shift(); // Keep last 10 rooms

            // Filter out rooms we have visited recently
            let validRooms = allExits.filter(r => !creep.memory.visited.includes(r));

            // If all exits are visited (dead end or loop), reset and pick any exit
            if (validRooms.length === 0) validRooms = allExits;

            creep.memory.targetRoom = validRooms[Math.floor(Math.random() * validRooms.length)];
        }

        // 3. Move to the target room
        if (creep.memory.targetRoom) {
            // Moving to a specific room position (25,25) handles the cross-room pathing automatically
            const pos = new RoomPosition(25, 25, creep.memory.targetRoom);
            creep.moveTo(pos, {visualizePathStyle: {stroke: '#ffffff'}, range: 1});
        }
    }
};

module.exports = roleScout;
