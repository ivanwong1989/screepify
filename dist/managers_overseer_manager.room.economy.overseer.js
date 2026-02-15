const overseerIntel = require('managers_overseer_intel_overseer.intel');
const overseerResourceLedger = require('managers_overseer_intel_overseer.resourceLedger');
const overseerMissions = require('managers_overseer_missions_overseer.missions');
const overseerUtils = require('managers_overseer_utils_overseer.utils');

const getRemoteCreepsByHomeRoom = function() {
    const cache = global._remoteCreepsByHomeRoom;
    if (cache && cache.time === Game.time) return cache.byRoom;

    const byRoom = {};
    const creeps = Object.values(Game.creeps);
    for (const creep of creeps) {
        if (!creep || !creep.my) continue;
        const memory = creep.memory || {};
        const home = memory.room;
        if (!home) continue;
        if (creep.room && creep.room.name === home) continue;

        if (!byRoom[home]) {
            byRoom[home] = { assigned: [], idle: [] };
        }
        if (memory.missionName) byRoom[home].assigned.push(creep);
        else byRoom[home].idle.push(creep);
    }

    global._remoteCreepsByHomeRoom = { time: Game.time, byRoom };
    return byRoom;
};

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

        // 2. Build Resource Ledger (room stock snapshot)
        const ledger = overseerResourceLedger.gather(room, intel);
        room._resourceLedger = ledger;
        if (Memory.debugLedger) {
            room.memory.overseer.resourceLedger = ledger;
        } else {
            room.memory.overseer.resourceLedger = {
                time: ledger.time,
                totals: ledger.totals,
                byType: ledger.byType,
                energy: ledger.energy,
                has: ledger.has
            };
        }
        if (Memory.debug) {
            const energy = ledger.energy || {};
            debug(
                'overseer.ledger',
                `[Ledger] ${room.name} energy=${energy.total || 0} (storage=${energy.storage || 0}, terminal=${energy.terminal || 0}, containers=${energy.containers || 0}, labs=${energy.labs || 0}, links=${energy.links || 0}) totals=${JSON.stringify(ledger.totals)}`
            );
        }

        // 3. Determine Room State
        const state = overseerIntel.determineState(room, intel);
        const economyState = overseerIntel.determineEconomyState(room, intel);

        // 4. Build Census (include remote creeps assigned to this home room)
        const remoteByHome = getRemoteCreepsByHomeRoom();
        const remote = remoteByHome[room.name] || { assigned: [], idle: [] };
        const censusCreeps = intel.myCreeps.concat(remote.assigned || [], remote.idle || []);

        // 5. Generate Missions
        const missions = overseerMissions.generate(room, intel, state, economyState, censusCreeps);

        // 6. Analyze Census (Match Creeps to Missions)
        overseerUtils.analyzeCensus(missions, censusCreeps);

        // 7. Reassign Workers (Optimize assignments)
        overseerUtils.reassignWorkers(room, missions, intel);

        // 8. Publish Missions (Contract for Tasker and Spawner)
        room._missions = missions;
        room._state = state;
        room._economyState = economyState;

        // Avoid dumping full mission objects into persistent memory by default.
        // Enable `Memory.debugMissions = true` to inspect full mission data.
        if (Memory.debugMissions) {
            room.memory.overseer.missions = missions;
        } else {
            delete room.memory.overseer.missions;
        }
        room.memory.overseer.state = state;
        room.memory.overseer.economyState = economyState;
    }
};

module.exports = managerOverseer;
