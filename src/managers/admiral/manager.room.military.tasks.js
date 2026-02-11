const admiralTactics = require('managers_admiral_tactics_admiral.tactics');

/**
 * Enhanced Military Tasker for Admiral Missions
 */
var militaryTasks = {
    run: function(room) {
        const allMissions = room._missions || [];
        const missions = allMissions.filter(m => m.type === 'defend' || m.type === 'patrol');
        const cache = global.getRoomCache(room);
        const defenders = (cache.myCreeps || []).filter(c => 
            c.memory.role === 'defender' || c.memory.role === 'brawler'
        );

        const hostiles = cache.hostiles || [];
        
        // Cleanup invalid missions
        admiralTactics.cleanupMissions(defenders, allMissions);

        missions.forEach(mission => {
            let assigned = defenders.filter(c => c.memory.missionName === mission.name);
            
            // 1. Assignment Logic
            const needed = (mission.requirements.count || 0) - assigned.length;
            if (needed > 0) {
                // Allow reassignment from patrol to defend
                const idleDefenders = defenders.filter(c => 
                    (!c.memory.missionName || 
                     c.memory.missionName.includes('decongest') || 
                     (mission.type === 'defend' && c.memory.missionName.includes('patrol'))) 
                    && !c.spawning
                );
                for (let i = 0; i < needed && i < idleDefenders.length; i++) {
                    const idle = idleDefenders[i];
                    idle.memory.missionName = mission.name;
                    idle.say('ðŸ›¡ï¸');
                    assigned.push(idle);
                }
            }

            if (mission.census) mission.census.count = assigned.length;

            // 2. Tactical Execution
            if (mission.type === 'defend') {
                const primaryTarget = admiralTactics.selectPrimaryTarget(hostiles);
                assigned.forEach(creep => {
                    if (!creep.spawning) {
                        admiralTactics.executeTactics(creep, hostiles, assigned, room, primaryTarget);
                    }
                });
            } else if (mission.type === 'patrol') {
                assigned.forEach(creep => {
                    if (!creep.spawning) {
                        admiralTactics.executePatrol(creep, assigned, room);
                    }
                });
            }
        });
    }
};

module.exports = militaryTasks;
