const admiralIntel = require('managers_admiral_intel_admiral.intel');
const admiralMissions = require('managers_admiral_missions_admiral.missions');

/**
 * The Admiral is the military counterpart to the Overseer.
 * It monitors threats and manages combat missions with advanced assessment.
 */
var managerAdmiral = {
    run: function(room) {
        if (!room.memory.admiral) room.memory.admiral = {};

        // 1. Military Intel
        const cache = global.getRoomCache(room);
        const hostiles = cache.hostiles || [];
        const threat = admiralIntel.analyzeThreat(hostiles);
        const budget = room.energyCapacityAvailable;

        // 2. Determine Combat State
        const state = admiralIntel.determineCombatState(hostiles, threat);

        // 3. Generate Missions
        const missions = admiralMissions.generate(room, hostiles, threat, state, budget);

        // 4. Publish to shared mission pool
        if (!room._missions) room._missions = [];
        room._missions = room._missions.concat(missions);
        
        room._combatState = state;
        room.memory.admiral.state = state;

        if (Memory.debug && state !== 'PEACE' && missions.length > 0) {
            const m = missions[0];
            const strat = m.data && m.data.strategy ? m.data.strategy : 'N/A';
            const formation = m.data && m.data.formation ? m.data.formation : 'N/A';
            console.log(`[Admiral] Room ${room.name} state: ${state}, Strat: ${strat}, Formation: ${formation}`);
        }
    }
};

module.exports = managerAdmiral;
