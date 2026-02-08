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
        const creeps = room.find(FIND_MY_CREEPS);
        
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
    },

    generateMissions: function(room, state) {
        const missions = [];
        
        // Harvest Missions (Always needed)
        room.find(FIND_SOURCES).forEach(source => {
            missions.push({
                id: `harvest_${source.id}`,
                role: 'harvester',
                priority: 100,
                data: { targetId: source.id, action: 'harvest' }
            });
        });

        // State Specific
        if (state === 'DEFENSE') {
            // ... generate defense missions
        } else if (state === 'GROWTH') {
            room.find(FIND_CONSTRUCTION_SITES).forEach(site => {
                missions.push({
                    id: `build_${site.id}`,
                    role: 'builder',
                    priority: 50,
                    data: { targetId: site.id, action: 'build' }
                });
            });
        }
        
        // Upgrading (Always needed)
        missions.push({
            id: `upgrade_${room.controller.id}`,
            role: 'upgrader',
            priority: 10,
            data: { targetId: room.controller.id, action: 'upgrade' }
        });

        return missions;
    },

    findMissionForCreep: function(creep, missions) {
        // Simple matching: Role match + lowest assignment count
        // In reality, you'd check distance, body capability, etc.
        const role = creep.memory.role;
        // Filter by role compatibility
        const candidates = missions.filter(m => {
            if (role === 'harvester_big') return m.role === 'harvester';
            return m.role === role;
        });
        
        // Sort by priority then assignment count
        candidates.sort((a, b) => {
            if (b.priority !== a.priority) return b.priority - a.priority;
            return (a.assigned || 0) - (b.assigned || 0);
        });
        
        return candidates[0];
    },

    isMissionValid: function(missionId, currentMissions) {
        return currentMissions.some(m => m.id === missionId);
    }
};
