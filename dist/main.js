var registerGlobals = require('bootstrap_globals');
var registerConsole = require('console_index');
var MemoryHack = require('utils_memoryHack');

MemoryHack.register();
registerGlobals();
registerConsole();

var roleUniversal = require('role.universal');
var roleEmpireUniversal = require('role.empire.universal');
var roleDefender = require('role.defender');
var roleAssault = require('role.assault');
var roleTower = require('role.tower');
var roleCoreLaneHauler = require('role.coreLaneHauler');
var roleMiningLaneHauler = require('role.miningLaneHauler');
var runColony = require('runColony');
var telemetry = require('telemetry_index');
var managerGlobalSpawner = require('managers_spawner_manager.global.spawner');
var safemodeManager = require('managers_safemode_safemodeManager');
var managerZeadmin = require('managers_zeadmin_manager.global.zeadmin');
var empireScaffold = require('managers_zeadmin_manager.global.zeadmin.empire.scaffold');


// CONSTANTS
const SAFE_MODE_ROOMS = new Set([
    'W44S28'
]);


/*
// Any modules that you use that modify the game's prototypes should be require'd
// before you require the profiler.
const profiler = require('screeps-profiler');

profiler.registerFN(global.getRoomCache, 'utils.getRoomCache');
profiler.registerObject(require('runColony'), 'runColony');
profiler.registerObject(require('managers_overseer_manager.room.economy.overseer'), 'overseer');
profiler.registerObject(require('managers_admiral_manager.room.military.admiral'), 'admiral');
profiler.registerObject(require('managers_admiral_manager.room.military.tasks'), 'milTasks');
profiler.registerObject(require('managers_spawner_manager.room.economy.spawner'), 'spawner');
profiler.registerObject(require('managers_structures_manager.structures'), 'structures');
profiler.registerObject(require('telemetry_index'), 'telemetry');
profiler.registerObject(require('managers_overseer_tasks_assign_manager.room.economy.tasks.assign'), 'tasks.assign');
profiler.registerObject(require('role.universal'), 'role.universal');

profiler.registerObject(require('managers_overseer_intel_overseer.intel'), 'overseer.intel');
profiler.registerObject(require('managers_overseer_intel_overseer.resourceLedger'), 'overseer.resourceLedger');
profiler.registerObject(require('managers_overseer_missions_overseer.missions'), 'overseer.missions');
profiler.registerObject(require('managers_overseer_utils_overseer.utils'), 'overseer.utils');

[
    ['managers_overseer_missions_board_types_mission.harvest', 'mission.harvest'],
    ['managers_overseer_missions_board_types_mission.build', 'mission.build'],
    ['managers_overseer_missions_board_types_mission.repair', 'mission.repair'],
    ['managers_overseer_missions_board_types_mission.upgrade', 'mission.upgrade'],
    ['managers_overseer_missions_board_types_mission.logisticsLane', 'mission.logisticsLane'],
    ['managers_overseer_missions_board_types_mission.logisticsJob', 'mission.logisticsJob'],
    ['managers_overseer_missions_board_types_mission.logisticsFleet', 'mission.logisticsFleet'],
    ['managers_overseer_missions_board_types_mission.remoteHarvest', 'mission.remoteHarvest'],
    ['managers_overseer_missions_board_types_mission.remoteHaul', 'mission.remoteHaul'],
    ['managers_overseer_missions_board_types_mission.scout', 'mission.scout'],
    ['managers_overseer_missions_board_types_mission.mineral', 'mission.mineral'],
    ['managers_overseer_missions_board_types_mission.decongest', 'mission.decongest'],
    ['managers_overseer_missions_board_types_mission.contract', 'mission.contract'],
    ['managers_overseer_missions_board_types_mission.userTransfer', 'mission.userTransfer'],
    ['managers_overseer_missions_board_types_mission.userRemoteMove2Flag', 'mission.userRemoteMove2Flag'],
    ['managers_overseer_missions_board_types_mission.userRemoteReserve', 'mission.userRemoteReserve'],
    ['managers_overseer_missions_board_types_mission.userRemoteClaim', 'mission.userRemoteClaim'],
    ['managers_overseer_missions_board_types_mission.userDismantle', 'mission.userDismantle'],
    ['managers_overseer_missions_board_types_mission.towerService', 'mission.tower'],
    ['managers_overseer_missions_board_types_mission.labs', 'mission.labs'],
    ['managers_overseer_missions_board_types_mission.remoteBuild', 'mission.remoteBuild']
].forEach(([moduleId, label]) => profiler.registerObject(require(moduleId), label));
*/



// This line monkey patches the global prototypes.
//profiler.enable();
module.exports.loop = function() {
    //profiler.wrap(function() {
        // Main.js logic should go here.

        // --- Memhack ---
        MemoryHack.runHack();

        // --- Quick dirty shard detection and pixel farm for now --- 
        // --- shard-specific pixel logic ---
        if (Game.shard && Game.shard.name === 'shard2') {
            if (Game.cpu.bucket >= 10000) {
                Game.cpu.generatePixel();
            }
        }
        // --- END Quick dirty shard detection and pixel farm for now ---

        // --- Initialize Remote Memory ---
        if (!Memory.remoteRooms) Memory.remoteRooms = {};

        // --- Memory name garbage clearing ---
        for (var name in Memory.creeps) {
            if (!Game.creeps[name]) {
                delete Memory.creeps[name];
                debug('system', 'Clearing non-existing creep memory:', name);
            }
        }

        // --- Run Mission Manager ---

        // --- COLONY LOOP ---
        const allCreeps = Object.values(Game.creeps);

        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];

            // Check if this is a valid colony (Owned controller + Spawns)
            if (room.controller && room.controller.my) {
                const cache = global.getRoomCache(room);
                
                // --- SAFE MODE (cheap + conservative) ---
                if (SAFE_MODE_ROOMS.has(room.name)) {
                    safemodeManager.run(room, cache, {
                        weakRampartHits: 5000,       // tweak later if needed
                        hostileNearSpawnRange: 1,
                        minRetryInterval: 5
                    });
                }

                const spawns = cache.myStructuresByType[STRUCTURE_SPAWN] || [];
                if (spawns.length > 0) {
                    // Run Colony Logic for this room
                    runColony.run(room, spawns[0], allCreeps);
                }

                // Run towers after Colony Logic (so Tasker has assigned tasks)
                const towers = cache.myStructuresByType[STRUCTURE_TOWER] || [];
                for (const tower of towers) {
                    roleTower.run(tower);
                }
            }
        }

        // --- ZEADMIN (empire-level read-only snapshot) ---
        empireScaffold.setEnabled(true);
        const empireRuntime = empireScaffold.run();
        managerZeadmin.run();

        // --- GLOBAL SPAWN MANAGER ---
        // Collect per-tick spawn candidates from all rooms
        let allSpawnCandidates = [];
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (room._spawnCandidates) allSpawnCandidates.push(...room._spawnCandidates);
        }
        if (empireRuntime && empireRuntime.enabled && Array.isArray(empireRuntime.candidates) && empireRuntime.candidates.length > 0) {
            allSpawnCandidates.push(...empireRuntime.candidates);
        }
        managerGlobalSpawner.run(allSpawnCandidates);

        // --- CREEP RUN LOGIC ---
        // Run creep logic globally, as they may be in any room
        for (var name in Game.creeps) {
            var creep = Game.creeps[name];
            if (creep.memory && creep.memory.homeRoom) delete creep.memory.homeRoom;
            if (creep.memory.role === 'defender' || creep.memory.role === 'brawler' || creep.memory.role === 'drainer') {
                roleDefender.run(creep);
            } else if (creep.memory.role === 'assault') {
                roleAssault.run(creep);
            } else if ([
                'empire_universal',
                'universal',
                'coreLaneHauler',
                'miningLaneHauler',
                'miner',
                'remote_miner',
                'mineral_miner',
                'mobile_miner',
                'scout',
                'hauler',
                'user_hauler',
                'remote_hauler',
                'upgrader',
                'builder',
                'repairer',
                'worker',
                'remote_worker',
                'dismantler',
                'reserver',
                'claimer',
                'move2flag'
            ].includes(creep.memory.role)) {
                if (creep.memory.role === 'empire_universal') {
                    roleEmpireUniversal.run(creep);
                } else if (creep.memory.role === 'coreLaneHauler') {
                    roleCoreLaneHauler.run(creep);
                } else if (creep.memory.role === 'miningLaneHauler') {
                    roleMiningLaneHauler.run(creep);
                } else {
                    roleUniversal.run(creep);
                }
            }
        }

        // Telemetry collection and printing
        telemetry.tick();
        telemetry.print();


    //});
};
