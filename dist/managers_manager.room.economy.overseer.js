module.exports = {
    /**
     * The Overseer acts as the "Brain" of the room.
     * It analyzes the environment and sets the high-level State and Goals.
     * It does NOT assign tasks or spawn creeps directly.
     * 
     * @param {Room} room
     */
    run: function(room) {
        // Initialize Brain Memory
        if (!room.memory.brain) {
            room.memory.brain = {
                state: 'STABLE'
            };
        }
        const brain = room.memory.brain;

        // 1. Gather Data (Census & Intel)
        const cache = global.getRoomCache(room);
        const creeps = cache.myCreeps || [];
        const hostiles = cache.hostiles || [];
        const sites = cache.constructionSites || [];
        const energyPct = room.energyAvailable / room.energyCapacityAvailable;

        // Check for decaying structures
        const decayingStructures = [
            ...(cache.structuresByType[STRUCTURE_ROAD] || []),
            ...(cache.structuresByType[STRUCTURE_CONTAINER] || []),
            ...(cache.structuresByType[STRUCTURE_RAMPART] || [])
        ].filter(s => {
            if (s.structureType === STRUCTURE_ROAD) return s.hits < s.hitsMax * 0.8;
            if (s.structureType === STRUCTURE_CONTAINER) return s.hits < s.hitsMax * 0.9;
            if (s.structureType === STRUCTURE_RAMPART) return s.hits < 5000; // Baseline
            return false;
        });

        // 2. Analyze Situation
        // Emergency: No creeps and low energy
        const isEmergency = creeps.length === 0;
        const underAttack = hostiles.length > 0;
        const hasConstruction = sites.length > 0;
        const needsRepair = decayingStructures.length > 0;

        // 3. Determine State
        // Priority: Emergency > Defense > Growth > Stable
        let state = 'STABLE';
        if (isEmergency) state = 'EMERGENCY';
        else if (underAttack) state = 'DEFENSE';
        else if (hasConstruction) state = 'GROWTH';

        // 4. Publish to Memory (for Tasks and Spawner to read)
        brain.state = state;
        brain.needs = {
            repair: needsRepair,
            build: hasConstruction,
            hostiles: underAttack
        };
        
        // Visual Debug
        new RoomVisual(room.name).text(`Brain: ${state}`, 1, 1, {align: 'left', opacity: 0.5});
    }
};
