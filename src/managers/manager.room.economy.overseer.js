const overseerIntel = require('managers_overseer_collaterals_overseer.intel');
const overseerMissions = require('managers_overseer_collaterals_overseer.missions');
const overseerUtils = require('managers_overseer_collaterals_overseer.utils');

/**
 * The Overseer acts as the "Brain" of the room.
 * It analyzes the environment and sets the high-level State and Goals.
 * It does NOT assign tasks or spawn creeps directly.
 * These are the scope of jobs overseer should look after in a room:
 * - Intel and data for the room, for example creep census, source positions, structures of interest, roads etc, intel that can
 *   help the overseer decide and guide the room
 * - Monitor energy requirements, part throughput and capacity limits. For example if it detects there's a container right beside the 
 *   energy source, then it knows it can use static harvesters paired with haulers. 
 * - Overseer does NOT make the lower level tasks and tracking creep states, however it sees the strategic flow of the room, 
 *   when to enable missions for static mining + haulers combo, or fall back to normal moving miners. Do we need a to refill the extensions or
 *   spawns, is it a good time to upgrade controller. etc. 
 * - Monitors for emergency room states like being defensive, or surplus, and creates those missions accordingly to be consumed by tasker
 * - Monitors for constructions needed if there is too much then guides the room to have builders etc
 * - Overseer specifies the requirement of the work for example i want 10 energy/tick extraction here on this source, or i want 20 hits/tick construction on here
 *   this requirement will be sent to spawner.
 * - Overseer sets the mission priority. 
 * - There should be a common mission interface agreed by overseer, tasker and spawner. This is akin to a contract that get's written by overseer, and 
 *   consumed by tasker and spawner. 
 */
var managerOverseer = {
    /**
     * Main run loop for the Overseer.
     * @param {Room} room
     */
    run: function(room) {
        if (!room.memory.overseer) room.memory.overseer = {};

        // 1. Gather Intel
        const intel = overseerIntel.gather(room);

        // 2. Determine Room State
        const state = overseerIntel.determineState(room, intel);
        const economyState = overseerIntel.determineEconomyState(room, intel);

        // 3. Generate Missions
        const missions = overseerMissions.generate(room, intel, state, economyState);

        // 4. Analyze Census (Match Creeps to Missions)
        overseerUtils.analyzeCensus(missions, intel.myCreeps);

        // 4.5 Reassign Workers (Optimize assignments)
        overseerUtils.reassignWorkers(room, missions, intel);

        // 5. Publish Missions (Contract for Tasker and Spawner)
        room._missions = missions;
        room._state = state;
        room._economyState = economyState;

        room.memory.overseer.missions = missions;
        room.memory.overseer.state = state;
        room.memory.overseer.economyState = economyState;

        if (Memory.debug) {
            overseerUtils.visualize(room, missions, state, economyState);
        }
    }
};

module.exports = managerOverseer;