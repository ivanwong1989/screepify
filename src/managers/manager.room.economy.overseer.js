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
                state: 'STABLE',
                metrics: {},
                counts: {}
            };
        }
        const brain = room.memory.brain;

        // 1. Gather Data (Census & Intel)
        const creeps = room.find(FIND_MY_CREEPS);
        const hostiles = room.find(FIND_HOSTILE_CREEPS);
        const sites = room.find(FIND_CONSTRUCTION_SITES);
        const energyPct = room.energyAvailable / room.energyCapacityAvailable;

        // 2. Analyze Situation
        const isEmergency = creeps.length === 0 && room.energyAvailable < 300;
        const underAttack = hostiles.length > 0;
        const hasConstruction = sites.length > 0;

        // 3. Determine State
        let state = 'STABLE';
        if (isEmergency) state = 'EMERGENCY';
        else if (underAttack) state = 'DEFENSE';
        else if (hasConstruction) state = 'GROWTH';

        // 4. Publish to Memory (for Tasks and Spawner to read)
        brain.state = state;
        brain.counts = _.countBy(creeps, c => c.memory.role);
        brain.metrics = { energyPct, hostileCount: hostiles.length, siteCount: sites.length };
        
        // Visual Debug
        new RoomVisual(room.name).text(`Brain: ${state}`, 1, 1, {align: 'left', opacity: 0.5});
    }
};
