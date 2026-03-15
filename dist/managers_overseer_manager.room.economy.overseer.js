const overseerIntel = require('managers_overseer_intel_overseer.intel');
const overseerResourceLedger = require('managers_overseer_intel_overseer.resourceLedger');
const overseerOpportunisticRepair = require('managers_overseer_intel_overseer.opportunistic.repair');
const overseerMissions = require('managers_overseer_missions_overseer.missions');
const missionBoard = require('managers_overseer_missions_board_missionBoard');
const remoteUtils = require('managers_overseer_utils_overseer.remote');
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

const getMyUsername = function(room) {
    if (room && room.controller && room.controller.my && room.controller.owner) {
        return room.controller.owner.username;
    }
    const spawns = room ? room.find(FIND_MY_SPAWNS) : [];
    if (spawns && spawns.length > 0 && spawns[0].owner) return spawns[0].owner.username;
    return null;
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
        const combatState = room.memory && room.memory.admiral && room.memory.admiral.state;
        const hostilesPresent = intel.hostiles && intel.hostiles.length > 0;
        const previousRepairScan = overseerOpportunisticRepair.getRoomScan(room.name);
        overseerOpportunisticRepair.scan(room, intel, {
            scanInterval: 7,
            forceScan: hostilesPresent || combatState === 'SIEGE' || !!(previousRepairScan && previousRepairScan.critical)
        });

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
        const opState = overseerIntel.determineOpState(room, intel);
        const economyState = overseerIntel.determineEconomyState(room, intel);
        const myUser = getMyUsername(room);

        // Keep opportunistic road repair targets warm for reserved, visible remotes.
        // This enables micro-repair in remote harvest rooms without full remote repair missions.
        if (myUser) {
            const remoteEntries = remoteUtils.getRemoteEconomicContext(room, {
                opState,
                maxScoutAge: 4000
            });
            for (let i = 0; i < remoteEntries.length; i++) {
                const remote = remoteEntries[i];
                if (!remote || !remote.enabled || !remote.room) continue;
                const remoteRoom = remote.room;
                const controller = remoteRoom.controller;
                const reservation = controller && controller.reservation;
                const reservedByMe = reservation && reservation.username === myUser;
                if (reservedByMe) {
                    overseerOpportunisticRepair.scanRoads(remoteRoom, { scanInterval: 11 });
                } else {
                    overseerOpportunisticRepair.clearRoom(remoteRoom.name);
                }
            }
        }

        // 4. Build Census (include remote creeps assigned to this home room)
        const remoteByHome = getRemoteCreepsByHomeRoom();
        const remote = remoteByHome[room.name] || { assigned: [], idle: [] };

        // Only count creeps that *belong* to this room (home/owner semantics).
        // Physical-local creeps from other home rooms should not inflate this room's fleet census.
        const localOwned = (intel.myCreeps || []).filter(c =>
            c && c.my && c.memory && c.memory.room === room.name
        );
        const censusCreeps = localOwned.concat(remote.assigned || [], remote.idle || []);

        // 5. Generate Missions
        const missions = overseerMissions.generate(room, intel, opState, economyState, censusCreeps);

        // 6. Analyze Census (Match Creeps to Missions)
        overseerUtils.analyzeCensus(missions, censusCreeps);

        // 7. Reassign Workers (Optimize assignments)
        overseerUtils.reassignWorkers(room, missions, intel);

        // 8. Publish Missions (Contract for Tasker and Spawner)
        room._missions = missions;
        room._opState = opState;
        room._economyState = economyState;

        // Avoid dumping full mission objects into persistent memory by default.
        // Enable `Memory.debugMissions = true` to inspect full mission data.
        if (Memory.debugMissions) {
            room.memory.overseer.missions = missions;
        } else {
            delete room.memory.overseer.missions;
        }
        room.memory.overseer.opState = opState;
        room.memory.overseer.economyState = economyState;

        // Mission board debug summary (cheap aggregate, no deep payload).
        if (Memory.debugMissionBoard || Memory.debugMissions) {
            const summary = missionBoard.getSummaryForRoom(room.name);
            room.memory.overseer.missionBoardSummary = summary;
            const state = summary.byState || {};
            const runtime = summary.runtime || {};
            const updates = runtime.updates || {};
            const create = runtime.create || {};
            const detectors = runtime.detectors || {};
            debug(
                'missions.board',
                `[MissionBoard] ${room.name} total=${summary.total} live=${summary.live} terminal=${summary.terminal} ` +
                `active=${state.active || 0} blocked=${state.blocked || 0} done=${state.done || 0} ` +
                `cancelled=${state.cancelled || 0} expired=${state.expired || 0} demand=${summary.demandCount} ` +
                `upd(live=${updates.live || 0} sel=${updates.selected || 0} checked=${updates.checked || 0} throttled=${updates.throttleFiltered || 0} ` +
                `legacySkip=${updates.legacySkipped || 0} invalid=${updates.invalid || 0} done=${updates.completed || 0}) ` +
                `create(att=${create.attempted || 0} new=${create.created || 0} exist=${create.existing || 0} cap=${create.capped || 0}) ` +
                `det(total=${detectors.total || 0} ran=${detectors.ran || 0} filtered=${detectors.filtered || 0} err=${detectors.errors || 0})`
            );
        } else if (room.memory.overseer.missionBoardSummary) {
            delete room.memory.overseer.missionBoardSummary;
        }
    }
};

module.exports = managerOverseer;
