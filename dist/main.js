var registerGlobals = require('bootstrap_globals');
var registerConsole = require('console_index');
var MemoryHack = require('utils_memoryHack');
//const profiler = require('screeps-profiler');
const { profRequire } = require('utils_profRequire');

MemoryHack.register();
registerGlobals();
registerConsole();

var roleUniversal = profRequire('role_role.universal', 'role.universal');
var roleEmpireUniversal = profRequire('role_role.empire.universal', 'role.empire.universal');
var roleDefender = profRequire('role_role.defender', 'role.defender');
var roleAssault = profRequire('role_role.assault', 'role.assault');
var roleTower = profRequire('role_role.tower', 'role.tower');
var roleCoreLaneHauler = profRequire('role_role.coreLaneHauler', 'role.coreLaneHauler');
var roleMiningLaneHauler = profRequire('role_role.miningLaneHauler', 'role.miningLaneHauler');
var roleSimpleHaulerCore = profRequire('role_role.simpleHaulerCore', 'role.simpleHaulerCore');
var roleSimpleMiningHauler = profRequire('role_role.simpleMiningHauler', 'role.simpleMiningHauler');
var roleWorker = profRequire('role_role.worker', 'role.worker');
var roleUpgrader = profRequire('role_role.upgrader', 'role.upgrader');
var roleMiner = profRequire('role_role.miner', 'role.miner');
var roleSimpleHarvest = profRequire('role_role.simpleHarvest', 'role.simpleHarvest');
var roleRemoteHarvest = profRequire('role_role.remoteHarvest', 'role.remoteHarvest');
var roleRemoteHaul = profRequire('role_role.remoteHaul', 'role.remoteHaul');
var roleRemoteReserve = profRequire('role_role.remoteReserve', 'role.remoteReserve');
var roleRemoteWorker = profRequire('role_role.remoteWorker', 'role.remoteWorker');
var roleMineralMiner = profRequire('role_role.mineralMiner', 'role.mineralMiner');
var roleScout = profRequire('role_role.scout', 'role.scout');
var runColony = profRequire('runColony', 'runColony');
var movement = require('utils_movement');
var borderNav = require('utils_creepBorderNav');
var telemetry = require('telemetry_index');
var managerGlobalSpawner = require('managers_spawner_manager.global.spawner');
var safemodeManager = require('managers_safemode_safemodeManager');
var managerZeadmin = require('managers_zeadmin_manager.global.zeadmin');
var empireScaffold = require('managers_zeadmin_manager.global.zeadmin.empire.scaffold');


// CONSTANTS
const SAFE_MODE_ROOMS = new Set([
    'W44S28'
]);

function handleTravelToHome(creep) {
    if (!creep || !creep.memory || !creep.memory._travellingToHome) return false;
    if (borderNav.handleBorderNudgeTick(creep)) return true;
    const homeRoomName = creep.memory.room;
    if (!homeRoomName) {
        delete creep.memory._travellingToHome;
        if (creep.memory.spawnRoom) delete creep.memory.spawnRoom;
        if (creep.memory.homeSpawnPos) delete creep.memory.homeSpawnPos;
        return false;
    }

    const isInHomeRoom = creep.room && creep.room.name === homeRoomName;
    const isOnBorder = creep.pos && (creep.pos.x === 0 || creep.pos.x === 49 || creep.pos.y === 0 || creep.pos.y === 49);
    if (isInHomeRoom && !isOnBorder) {
        delete creep.memory._travellingToHome;
        if (creep.memory.spawnRoom) delete creep.memory.spawnRoom;
        if (creep.memory.homeSpawnPos) delete creep.memory.homeSpawnPos;
        return false;
    }

    const homeSpawn = borderNav.getHomeSpawnTarget(creep);
    if (homeSpawn) {
        borderNav.moveToTarget(creep, homeSpawn, 2);
    } else if (Game.rooms[homeRoomName] && Game.rooms[homeRoomName].controller) {
        borderNav.moveToTarget(creep, Game.rooms[homeRoomName].controller, 2);
    } else {
        // Last-resort fallback if home spawn position is unavailable.
        borderNav.moveToTarget(creep, new RoomPosition(25, 25, homeRoomName), 20);
    }
    return true;
}

/*
// Any modules that you use that modify the game's prototypes should be require'd
// before you require the profiler.
profiler.registerFN(global.getRoomCache, 'utils.getRoomCache');
profiler.registerObject(require('runColony'), 'runColony');
profiler.registerObject(require('managers_overseer_manager.room.economy.overseer'), 'overseer');
profiler.registerObject(require('managers_admiral_manager.room.military.admiral'), 'admiral');
profiler.registerObject(require('managers_admiral_manager.room.military.tasks'), 'milTasks');
profiler.registerObject(require('managers_spawner_manager.room.economy.spawner'), 'spawner');
profiler.registerObject(require('managers_structures_manager.structures'), 'structures');
profiler.registerObject(require('telemetry_index'), 'telemetry');
profiler.registerObject(require('managers_overseer_tasks_assign_manager.room.economy.tasks.assign'), 'tasks.assign');
profiler.registerObject(require('role_role.universal'), 'role.universal');

profiler.registerObject(require('managers_overseer_intel_overseer.intel'), 'overseer.intel');
profiler.registerObject(require('managers_overseer_intel_overseer.resourceLedger'), 'overseer.resourceLedger');
profiler.registerObject(require('managers_overseer_missions_overseer.missions'), 'overseer.missions');
profiler.registerObject(require('managers_overseer_utils_overseer.utils'), 'overseer.utils');

[
    ['managers_overseer_missions_board_types_mission.harvest', 'mission.harvest'],
    ['managers_overseer_missions_board_types_mission.build', 'mission.build'],
    ['managers_overseer_missions_board_types_mission.repair', 'mission.repair'],
    ['managers_overseer_missions_board_types_mission.fortify', 'mission.fortify'],
    ['managers_overseer_missions_board_types_mission.upgrade', 'mission.upgrade'],
    ['managers_overseer_missions_board_types_mission.remoteHarvest', 'mission.remoteHarvest'],
    ['managers_overseer_missions_board_types_mission.remoteHaul', 'mission.remoteHaul'],
    ['managers_overseer_missions_board_types_mission.scout', 'mission.scout'],
    ['managers_overseer_missions_board_types_mission.mineral', 'mission.mineral'],
    ['managers_overseer_missions_board_types_mission.userRemoteMove2Flag', 'mission.userRemoteMove2Flag'],
    ['managers_overseer_missions_board_types_mission.tower', 'mission.tower'],
    ['managers_overseer_missions_board_types_mission.remoteBuild', 'mission.remoteBuild']
].forEach(([moduleId, label]) => profiler.registerObject(require(moduleId), label));

*/



function runMainLoop() {
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
            if (handleTravelToHome(creep)) continue;
            if (creep.memory.role === 'defender' || creep.memory.role === 'brawler' || creep.memory.role === 'drainer') {
                roleDefender.run(creep);
            } else if (creep.memory.role === 'assault') {
                roleAssault.run(creep);
            } else if ([
                'empire_universal',
                'universal',
                'coreLaneHauler',
                'miningLaneHauler',
                'simpleHaulerCore',
                'simpleMiningHauler',
                'simple_miner',
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
                } else if (creep.memory.role === 'simpleHaulerCore') {
                    roleSimpleHaulerCore.run(creep);
                } else if (creep.memory.role === 'simpleMiningHauler') {
                    roleSimpleMiningHauler.run(creep);
                } else if (creep.memory.role === 'upgrader') {
                    roleUpgrader.run(creep);
                } else if (creep.memory.role === 'worker' || creep.memory.role === 'builder' || creep.memory.role === 'repairer') {
                    roleWorker.run(creep);
                } else if (creep.memory.role === 'simple_miner') {
                    roleSimpleHarvest.run(creep);
                } else if (creep.memory.role === 'miner' || creep.memory.role === 'mobile_miner') {
                    roleMiner.run(creep);
                } else if (creep.memory.role === 'remote_miner') {
                    roleRemoteHarvest.run(creep);
                } else if (creep.memory.role === 'remote_hauler') {
                    roleRemoteHaul.run(creep);
                } else if (creep.memory.role === 'reserver') {
                    roleRemoteReserve.run(creep);
                } else if (creep.memory.role === 'remote_worker') {
                    roleRemoteWorker.run(creep);
                } else if (creep.memory.role === 'mineral_miner') {
                    roleMineralMiner.run(creep);
                } else if (creep.memory.role === 'scout') {
                    roleScout.run(creep);
                } else {
                    roleUniversal.run(creep);
                }
            }
        }

        for (const roomName in Game.rooms) {
            movement.finalizeRoomTraffic(Game.rooms[roomName]);
        }

        // Telemetry collection and printing
        telemetry.tick();
        telemetry.print();
}

module.exports.loop = function() {
    /*
    if (Memory.profilerEnabled === true) {
        profiler.enable();
        return profiler.wrap(runMainLoop);
    }*/
    return runMainLoop();
};

