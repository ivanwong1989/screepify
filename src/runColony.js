const { profRequire } = require('utils_profRequire');

var managerOverseer = profRequire('managers_overseer_manager.room.economy.overseer', 'overseer');
var managerTasks = profRequire('managers_overseer_tasks_assign_manager.room.economy.tasks.assign', 'tasks.assign');
var managerStructures = profRequire('managers_structures_manager.structures', 'structures');
var managerSpawner = profRequire('managers_spawner_manager.room.economy.spawner', 'spawner');
const managerMilitaryTasks = profRequire('managers_admiral_manager.room.military.tasks', 'milTasks');
const managerAdmiral = profRequire('managers_admiral_manager.room.military.admiral', 'admiral');
const overseerUtils = profRequire('managers_overseer_utils_overseer.utils', 'overseer.utils');

const deriveOverallState = (roomState, combatState) => {
    if (combatState === 'SIEGE') return 'SIEGE';
    if (combatState === 'DEFEND') return 'DEFENSE';
    if (
        combatState === 'CAUTION'
        || roomState === 'CRITICAL'
        || roomState === 'RECOVER'
        || roomState === 'DEFENSIVE'
    ) return 'WATCH';
    return 'SAFE';
};

module.exports = {
    /**
     * Runs all logic for a specific owned room (Colony)
     * @param {Room} room 
     * @param {StructureSpawn} spawn 
     * @param {Creep[]} allCreeps 
     */
    run: function(room, spawn, allCreeps) {
        // 1. Overseer: Analyze the room and set high-level goals/state
        managerOverseer.run(room);

        // 2. Admiral: Combat and threat analysis for the room and sets high level goals
        managerAdmiral.run(room);

        // 2.5 Unified Room State Summary (non-breaking, additive)
        const policyState = room._policy && room._policy.state ? room._policy.state : null;
        room._roomState = {
            phase: room && room._policy && room._policy.phase ? room._policy.phase : 'UNKNOWN',
            state: policyState,
            combat: room._combatState,
            overall: deriveOverallState(policyState, room._combatState)
        };

        // 3. Tasks: Generate missions, assign creeps, and request spawns if needed
        managerTasks.run(room);

        // 3.5 Military Tasks: Handle combat creep assignments and logic
        managerMilitaryTasks.run(room);

        // 4. Visualization: Draw the room state and missions (including military)
        if (Memory.debugVisual) {
            overseerUtils.visualize(room, room._missions, room._roomState);
        }

        // 3. Spawner: Generate spawn candidates
        managerSpawner.run(room, allCreeps);

        // 4. Structures: Run structure logic (Links, Terminal/Market, etc.)
        managerStructures.run(room);
    }
}

