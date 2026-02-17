module.exports = {
    run: function(allTickets) {
        if (!allTickets || allTickets.length === 0) return;

        // 1. Sort tickets by priority
        allTickets.sort((a, b) => b.priority - a.priority);
        debug('spawner', `[GlobalSpawner] tickets=${allTickets.length}`);

        // 2. Index available spawns
        const availableSpawns = [];
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (!room.controller || !room.controller.my) continue;
            
            const spawns = room.find(FIND_MY_SPAWNS);
            for (const spawn of spawns) {
                if (!spawn.spawning) {
                    availableSpawns.push(spawn);
                }
            }
        }

        // 3. Match Tickets to Spawns
        for (const ticket of allTickets) {
            if (availableSpawns.length === 0) break;

            const spawn = this.findBestSpawn(ticket, availableSpawns);
            
            if (spawn) {
                debug('spawner', `[GlobalSpawner] assign ticket=${ticket.ticketId} contract=${ticket.contractId} to spawn=${spawn.name} room=${spawn.room.name}`);
                this.executeSpawn(spawn, ticket);
                // Remove used spawn from available list
                const index = availableSpawns.indexOf(spawn);
                if (index > -1) availableSpawns.splice(index, 1);
            }
        }
    },

    findBestSpawn: function(ticket, availableSpawns) {
        
        // Filter 1: Capable of spawning (Energy Capacity)
        // We check capacity, not current available, because if it's local we might be waiting for refill (Grace Period handled in local manager, but we double check here)
        let candidates = availableSpawns.filter(s => s.room.energyCapacityAvailable >= ticket.cost);

        // Filter 2: Local Spawns (Priority)
        const localSpawns = candidates.filter(s => s.room.name === ticket.homeRoom);
        
        // Strategy: Try local first. If local exists, pick the one with enough energy NOW.
        const readyLocal = localSpawns.find(s => s.room.energyAvailable >= ticket.cost);
        if (readyLocal) return readyLocal;

        // Filter 3: Remote Spawns
        // We only consider remote spawns if they are ready to spawn NOW.
        // We don't want to wait on a remote room's energy regeneration.
        const remoteCandidates = candidates.filter(s => {
            if (s.room.name === ticket.homeRoom) return false;
            if (s.room.energyAvailable < ticket.cost) return false;
            if (s.room._state === 'EMERGENCY') return false;
            const dist = Game.map.getRoomLinearDistance(ticket.homeRoom, s.room.name);
            return dist <= 2; // Allow adjacent + 1
        });

        if (remoteCandidates.length > 0) {
            // Sort by distance, then by energy available
            remoteCandidates.sort((a, b) => {
                const distA = Game.map.getRoomLinearDistance(ticket.homeRoom, a.room.name);
                const distB = Game.map.getRoomLinearDistance(ticket.homeRoom, b.room.name);
                if (distA !== distB) return distA - distB;
                return b.room.energyAvailable - a.room.energyAvailable;
            });
            return remoteCandidates[0];
        }

        return null;

        //return availableSpawns.find(s => s.room.name === ticket.homeRoom && s.room.energyAvailable >= ticket.cost);
    },

    executeSpawn: function(spawn, ticket) {
        const name = `${ticket.role}_${Game.time.toString(36)}_${Math.floor(Math.random()*100)}`;
        const memory = Object.assign({}, ticket.memory);
        
        // Canonicalize home vs spawn room fields for debugging and future census logic.
        memory.homeRoom = ticket.homeRoom;
        memory.spawnRoom = spawn.room.name;
        memory.room = ticket.homeRoom; // keep existing semantics: memory.room == home room
        memory.contractId = ticket.contractId;
        memory.ticketId = ticket.ticketId;

        // If remote, add travel intent based on bind mode.
        if (spawn.room.name !== ticket.homeRoom) {
            if (ticket.bindMode === 'pool') {
                memory._travellingToHome = true;
            } else if (ticket.travelTargetRoom) {
                memory.travelTargetRoom = ticket.travelTargetRoom;
            } else if (ticket.targetRoom) {
                memory.travelTargetRoom = ticket.targetRoom;
            }
        }

        const result = spawn.spawnCreep(ticket.body, name, { memory: memory });
        
        if (result === OK) {
            debug('spawner', `[GlobalSpawner] Spawning ${name} in ${spawn.room.name} for ${ticket.homeRoom} (Ticket: ${ticket.ticketId})`);

            if (Memory.spawnTickets && Memory.spawnTickets[ticket.ticketId]) {
                const stored = Memory.spawnTickets[ticket.ticketId];
                stored.state = 'SPAWNING';
                stored.creepName = name;
                stored.spawnRoom = spawn.room.name;
                stored.expiresAt = Game.time + (ticket.body.length * 3) + 10;
            }
            
            // Update Home Room History
            const homeRoom = Game.rooms[ticket.homeRoom];
            if (homeRoom && homeRoom.memory) {
                if (!homeRoom.memory.spawnHistory) homeRoom.memory.spawnHistory = [];
                homeRoom.memory.spawnHistory.push(ticket.role);
                if (homeRoom.memory.spawnHistory.length > 5) homeRoom.memory.spawnHistory.shift();
                
                // Reset wait ticks
                if (homeRoom.memory.spawner) homeRoom.memory.spawner.waitTicks = 0;
            }
        } else {
            debug('spawner', `[GlobalSpawner] spawn failed ${spawn.name} result=${result} ticket=${ticket.ticketId} contract=${ticket.contractId}`);
        }
    }
};
