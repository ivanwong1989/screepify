var registerGlobals = require('bootstrap_globals');
var registerConsole = require('console_index');

registerGlobals();
registerConsole();

var roleUniversal = require('role.universal');
var roleDefender = require('role.defender');
var roleTower = require('role.tower');
var runColony = require('runColony');
var cpuEma = require('telemetry_cpuEma');
var managerGlobalSpawner = require('managers_spawner_manager.global.spawner');

// Any modules that you use that modify the game's prototypes should be require'd
// before you require the profiler.
//const profiler = require('screeps-profiler');

// This line monkey patches the global prototypes.
//profiler.enable();
module.exports.loop = function() {
    //profiler.wrap(function() {
        // Main.js logic should go here.

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
                // --- TOWER RUN LOGIC ---
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

        // --- GLOBAL SPAWN MANAGER ---
        // Collect requests from all rooms
        let allSpawnRequests = [];
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (room._spawnRequests) allSpawnRequests.push(...room._spawnRequests);
        }
        managerGlobalSpawner.run(allSpawnRequests);

        // --- CREEP RUN LOGIC ---
        // Run creep logic globally, as they may be in any room
        for (var name in Game.creeps) {
            var creep = Game.creeps[name];
            if (creep.memory.role === 'defender' || creep.memory.role === 'brawler' || creep.memory.role === 'drainer') {
                roleDefender.run(creep);
            } else if ([
                'universal',
                'miner',
                'remote_miner',
                'mineral_miner',
                'mobile_miner',
                'scout',
                'hauler',
                'remote_hauler',
                'upgrader',
                'builder',
                'repairer',
                'worker',
                'remote_worker',
                'dismantler',
                'reserver',
                'claimer'
            ].includes(creep.memory.role)) {
                roleUniversal.run(creep);
            }
        }

        cpuEma.tick();

    //});
};
