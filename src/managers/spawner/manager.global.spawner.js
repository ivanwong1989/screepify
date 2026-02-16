module.exports = {
    run: function(allRequests) {
        if (!allRequests || allRequests.length === 0) return;

        // 1. Sort requests by priority
        allRequests.sort((a, b) => b.priority - a.priority);

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

        // 3. Match Requests to Spawns
        for (const request of allRequests) {
            if (availableSpawns.length === 0) break;

            const spawn = this.findBestSpawn(request, availableSpawns);
            
            if (spawn) {
                this.executeSpawn(spawn, request);
                // Remove used spawn from available list
                const index = availableSpawns.indexOf(spawn);
                if (index > -1) availableSpawns.splice(index, 1);
            }
        }
    },

    findBestSpawn: function(request, availableSpawns) {
        // Filter 1: Capable of spawning (Energy Capacity)
        // We check capacity, not current available, because if it's local we might be waiting for refill (Grace Period handled in local manager, but we double check here)
        let candidates = availableSpawns.filter(s => s.room.energyCapacityAvailable >= request.cost);

        // Filter 2: Local Spawns (Priority)
        const localSpawns = candidates.filter(s => s.room.name === request.homeRoom);
        
        // Strategy: Try local first. If local exists, pick the one with enough energy NOW.
        const readyLocal = localSpawns.find(s => s.room.energyAvailable >= request.cost);
        if (readyLocal) return readyLocal;

        // Filter 3: Remote Spawns
        // We only consider remote spawns if they are ready to spawn NOW.
        // We don't want to wait on a remote room's energy regeneration.
        const remoteCandidates = candidates.filter(s => {
            if (s.room.name === request.homeRoom) return false;
            if (s.room.energyAvailable < request.cost) return false;
            if (s.room._state === 'EMERGENCY') return false;
            const dist = Game.map.getRoomLinearDistance(request.homeRoom, s.room.name);
            return dist <= 2; // Allow adjacent + 1
        });

        if (remoteCandidates.length > 0) {
            // Sort by distance, then by energy available
            remoteCandidates.sort((a, b) => {
                const distA = Game.map.getRoomLinearDistance(request.homeRoom, a.room.name);
                const distB = Game.map.getRoomLinearDistance(request.homeRoom, b.room.name);
                if (distA !== distB) return distA - distB;
                return b.room.energyAvailable - a.room.energyAvailable;
            });
            return remoteCandidates[0];
        }

        return null; 
    },

    executeSpawn: function(spawn, request) {
        const name = `${request.memory.role}_${Game.time.toString(36)}_${Math.floor(Math.random()*100)}`;
        
        // If remote, add travel flag
        if (spawn.room.name !== request.homeRoom) {
            request.memory._travellingToHome = true;
        }

        const result = spawn.spawnCreep(request.body, name, { memory: request.memory });
        
        if (result === OK) {
            debug('spawner', `[GlobalSpawner] Spawning ${name} in ${spawn.room.name} for ${request.homeRoom} (Mission: ${request.memory.missionName})`);
            
            // Update Home Room History
            const homeRoom = Game.rooms[request.homeRoom];
            if (homeRoom && homeRoom.memory) {
                if (!homeRoom.memory.spawnHistory) homeRoom.memory.spawnHistory = [];
                homeRoom.memory.spawnHistory.push(request.memory.role);
                if (homeRoom.memory.spawnHistory.length > 5) homeRoom.memory.spawnHistory.shift();
                
                // Reset wait ticks
                if (homeRoom.memory.spawner) homeRoom.memory.spawner.waitTicks = 0;
            }
        }
    }
};
