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

profiler.registerObject(require('managers_overseer_missions_mission.tower'), 'mission.tower');
profiler.registerObject(require('managers_overseer_missions_mission.scout'), 'mission.scout');
profiler.registerObject(require('managers_overseer_missions_mission.remote.build'), 'mission.remote.build');
profiler.registerObject(require('managers_overseer_missions_mission.remote.repair'), 'mission.remote.repair');
profiler.registerObject(require('managers_overseer_missions_mission.remote.harvest'), 'mission.remote.harvest');
profiler.registerObject(require('managers_overseer_missions_mission.remote.haul'), 'mission.remote.haul');
profiler.registerObject(require('managers_overseer_missions_mission.user.remote.reserve'), 'mission.user.remote.reserve');
profiler.registerObject(require('managers_overseer_missions_mission.user.remote.claim'), 'mission.user.remote.claim');
profiler.registerObject(require('managers_overseer_missions_mission.user.remote.move2flag'), 'mission.user.remote.move2flag');
profiler.registerObject(require('managers_overseer_missions_mission.harvest'), 'mission.harvest');
profiler.registerObject(require('managers_overseer_missions_mission.mineral'), 'mission.mineral');
profiler.registerObject(require('managers_overseer_missions_mission.fleet_logistic'), 'mission.fleetLogistic');
profiler.registerObject(require('managers_overseer_missions_mission.logistics'), 'mission.logistics');
profiler.registerObject(require('managers_overseer_missions_mission.labs'), 'mission.labs');
profiler.registerObject(require('managers_overseer_missions_mission.upgrade'), 'mission.upgrade');
profiler.registerObject(require('managers_overseer_missions_mission.build'), 'mission.build');
profiler.registerObject(require('managers_overseer_missions_mission.repair'), 'mission.repair');
profiler.registerObject(require('managers_overseer_missions_mission.decongest'), 'mission.decongest');
profiler.registerObject(require('managers_overseer_missions_mission.user.dismantle'), 'mission.user.dismantle');
profiler.registerObject(require('managers_overseer_missions_mission.user.transfer'), 'mission.user.transfer');
profiler.registerObject(require('managers_overseer_missions_mission.idleUpgrade'), 'mission.idleUpgrade');
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
        if (!Memory.spawnTickets) Memory.spawnTickets = {};
        if (!global._spawningNamesCache || global._spawningNamesCache.time !== Game.time) {
            const spawningNames = new Set();
            for (const rn in Game.rooms) {
                const r = Game.rooms[rn];
                if (!r.controller || !r.controller.my) continue;
                const spawns = r.find(FIND_MY_SPAWNS);
                for (const s of spawns) {
                    if (s.spawning) spawningNames.add(s.spawning.name);
                }
            }
            global._spawningNamesCache = { time: Game.time, names: spawningNames };
        }

        // --- Spawn Ticket GC (prevents unbounded growth) ---
        (function cleanupSpawnTickets() {
            const tickets = Memory.spawnTickets;
            const spawningNames = global._spawningNamesCache && global._spawningNamesCache.time === Game.time
                ? global._spawningNamesCache.names
                : null;

            for (const id in tickets) {
                const t = tickets[id];
                if (!t) {
                    delete tickets[id];
                    continue;
                }

                const expired = t.expiresAt && t.expiresAt <= Game.time;
                const creepAlive = t.creepName && Game.creeps[t.creepName];
                const creepSpawning = t.creepName && spawningNames && spawningNames.has(t.creepName);

                if (expired && !creepAlive && !creepSpawning) {
                    delete tickets[id];
                    const home = t.homeRoom;
                    const contractId = t.contractId;
                    if (home && contractId && Memory.rooms && Memory.rooms[home] && Memory.rooms[home].spawnTicketsByKey) {
                        const index = Memory.rooms[home].spawnTicketsByKey;
                        const list = index[contractId];
                        if (list && list.length > 0) {
                            index[contractId] = list.filter(tid => tid !== id);
                        }
                    }
                    continue;
                }

                // If expired but creep exists, keep ticket and let tasker refresh.
                if (expired && creepAlive) {
                    t.expiresAt = Game.time + 10;
                }
            }
        })();

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
        managerZeadmin.run();
        empireScaffold.setEnabled(true);
        const empireRuntime = empireScaffold.run();

        // --- GLOBAL SPAWN MANAGER ---
        // Collect tickets from all rooms
        let allSpawnTickets = [];
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (room._spawnTicketsToRequest) allSpawnTickets.push(...room._spawnTicketsToRequest);
        }
        if (empireRuntime && empireRuntime.enabled && Array.isArray(empireRuntime.tickets) && empireRuntime.tickets.length > 0) {
            allSpawnTickets.push(...empireRuntime.tickets);
        }
        managerGlobalSpawner.run(allSpawnTickets);

        // --- CREEP RUN LOGIC ---
        // Run creep logic globally, as they may be in any room
        for (var name in Game.creeps) {
            var creep = Game.creeps[name];
            if (creep.memory.role === 'defender' || creep.memory.role === 'brawler' || creep.memory.role === 'drainer') {
                roleDefender.run(creep);
            } else if (creep.memory.role === 'assault') {
                roleAssault.run(creep);
            } else if ([
                'empire_universal',
                'universal',
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
