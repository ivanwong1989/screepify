module.exports = {
    /**
     * The Task Manager reads the Overseer's State and generates specific Missions.
     * It then assigns these missions to available creeps.
     * 
     * @param {Room} room
     */
    run: function(room) {
        if (!room.memory.brain) return;
        const state = room.memory.brain.state;
        
        // 1. Generate Missions based on State/Reality
        // In a full system, this would be persistent. For now, we calculate ephemeral needs.
        const missions = this.generateMissions(room, state);
        
        // 2. Assign Missions to Creeps
        const creeps = global.getRoomCache(room).myCreeps || [];
        
        creeps.forEach(creep => {
            // If creep has a valid mission, skip
            if (creep.memory.missionId && this.isMissionValid(creep.memory.missionId, missions)) {
                return;
            }
            
            // Find suitable mission
            const mission = this.findMissionForCreep(creep, missions);
            if (mission) {
                creep.memory.missionId = mission.id;
                creep.memory.taskData = mission.data; // Metadata for the creep to execute
                // Mark mission as assigned (simple round-robin prevention)
                mission.assigned = (mission.assigned || 0) + 1;
            } else {
                delete creep.memory.missionId;
                delete creep.memory.taskData;
            }
        });

        // 3. Generate Spawn Requests for Unassigned Missions
        const unassignedMissions = missions.filter(m => !m.assigned || m.assigned < (m.limit || 1));
        const spawnRequests = [];
        
        // Group unassigned missions by role to avoid spamming requests
        const counts = _.countBy(unassignedMissions, 'role');
        
        for (let role in counts) {
            // Find a representative mission to inherit priority
            const topMission = unassignedMissions.find(m => m.role === role);
            spawnRequests.push({
                role: role,
                count: counts[role],
                priority: topMission ? topMission.priority : 0
            });
        }
        
        // Publish requests to brain for Spawner
        room.memory.brain.spawnRequests = spawnRequests;
    },

    generateMissions: function(room, state) {
        const missions = [];
        const brain = room.memory.brain;
        const cache = global.getRoomCache(room);
        
        // Harvest Missions (Always needed)
        // Type: 'gather'
        room.find(FIND_SOURCES).forEach(source => {
            missions.push({
                id: `harvest_${source.id}`,
                role: 'universal',
                priority: 100,
                data: { targetId: source.id, action: 'harvest' },
                limit: 3, // Allow multiple harvesters per source for universal creeps
                type: 'gather'
            });
        });

        // Logistics: Fill Spawns & Extensions
        // Type: 'work' (delivering energy)
        const spawns = cache.structuresByType[STRUCTURE_SPAWN] || [];
        const extensions = cache.structuresByType[STRUCTURE_EXTENSION] || [];
        const energyStructures = [...spawns, ...extensions].filter(s => 
            s.my && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
        );
        
        energyStructures.forEach(s => {
            missions.push({
                id: `fill_${s.id}`,
                role: 'universal',
                priority: 200, // Higher priority than harvesting to keep spawning active
                data: { targetId: s.id, action: 'transfer' },
                limit: 1,
                type: 'work'
            });
        });

        // Logistics: Fill Towers
        const towers = (cache.structuresByType[STRUCTURE_TOWER] || []).filter(s => 
            s.my && s.store.getFreeCapacity(RESOURCE_ENERGY) > 200
        );
        towers.forEach(t => {
             missions.push({
                id: `fill_tower_${t.id}`,
                role: 'universal',
                priority: 150,
                data: { targetId: t.id, action: 'transfer' },
                limit: 1,
                type: 'work'
            });
        });

        // Build Missions
        // Limit to top 3 sites to avoid flooding mission list
        (cache.constructionSites || []).slice(0, 3).forEach(site => {
            missions.push({
                id: `build_${site.id}`,
                role: 'universal',
                priority: 50,
                data: { targetId: site.id, action: 'build' },
                limit: 3,
                type: 'work'
            });
        });

        // Pickup Dropped Resources
        (cache.dropped || []).filter(r => r.resourceType === RESOURCE_ENERGY).forEach(r => {
             missions.push({
                id: `pickup_${r.id}`,
                role: 'universal',
                priority: 120,
                data: { targetId: r.id, action: 'pickup' },
                limit: 1,
                type: 'gather'
            });
        });
        
        // Upgrading (Always needed)
        missions.push({
            id: `upgrade_${room.controller.id}`,
            role: 'universal',
            priority: 10,
            data: { targetId: room.controller.id, action: 'upgrade' },
            limit: 5,
            type: 'work'
        });

        return missions;
    },

    findMissionForCreep: function(creep, missions) {
        // Simple matching: Role match + lowest assignment count
        // In reality, you'd check distance, body capability, etc.
        const role = creep.memory.role;
        const hasEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
        const isFull = creep.store.getFreeCapacity() === 0;

        // Filter by role compatibility
        let candidates = missions.filter(m => {
            return m.role === role || (role === 'universal' && ['harvester', 'hauler', 'builder', 'upgrader'].includes(m.role));
        });
        
        // Filter by State (Gather vs Work)
        if (hasEnergy) {
            // If full, MUST work. If partial, prefer work but can gather if needed? 
            // For simplicity: If not empty, prefer Work. If empty, MUST Gather.
            // To avoid flip-flopping with partial energy, we stick to 'work' if we have any energy,
            // unless we are explicitly empty.
            // However, if we are not full, we *could* gather.
            // Let's enforce: Full -> Work. Empty -> Gather. Partial -> Gather (fill up).
            if (isFull) {
                candidates = candidates.filter(m => m.type === 'work');
            } else {
                candidates = candidates.filter(m => m.type === 'gather');
            }
        } else {
            candidates = candidates.filter(m => m.type === 'gather');
        }

        // Sort by priority then assignment count
        candidates.sort((a, b) => {
            if (b.priority !== a.priority) return b.priority - a.priority;
            // Could add distance check here
            return (a.assigned || 0) - (b.assigned || 0); 
        });
        
        // Check if mission has space
        const best = candidates[0];
        if (best && (best.assigned || 0) < (best.limit || 1)) {
            return best;
        }
        return null;
    },

    isMissionValid: function(missionId, currentMissions) {
        return currentMissions.some(m => m.id === missionId);
    }
};
