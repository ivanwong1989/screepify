var roleHarvester = require('role.harvester');
var roleHauler = require('role.hauler');
var roleHaulerControllerSpecial = require('role.hauler_controller_special');
var roleHarvesterBig = require('role.harvester_big');
var roleUpgrader = require('role.upgrader');
var roleBuilder = require('role.builder');
var roleTower = require('role.tower');
var roleDefender = require('role.defender');
var roleScout = require('role.scout');
var roleRemoteHarvester = require('role.remote_harvester');
var roleMissionDefenderRange = require('role.mission_defender_range');
var roleMissionDefenderTank = require('role.mission_defender_tank');
var roleMissionDecoy = require('role.mission_defender_decoy');
var roleMissionRangeHealer = require('role.mission_range_healer');
var roleMissionReserver = require('role.mission_reserver');
var roleMissionClaimer = require('role.mission_claimer');
var roleMissionDismantler = require('role.mission_dismantler');
var roleMissionBootstrap = require('role.mission_room_bootstrap_builder_harvester');
var roleMissionHaulerInterRoom = require('role.mission_hauler_interroom');
var roleMissionRemoteHarvester = require('role.mission_remote_harvester');
var roleMissionRemoteHauler = require('role.mission_remote_haulers');
var roleDrainer = require('role.drainer');
var managerMission = require('managers_manager.mission');
var managerRoomVisualizer = require('managers_manager.room.visualizer');
var runColony = require('runColony');
var libPathing = require('lib.pathing');
// Any modules that you use that modify the game's prototypes should be require'd
// before you require the profiler.
//const profiler = require('screeps-profiler');


// A simple, reliable custom logger
global.log = function(...args) {
    if (Memory.debug) {
        console.log(...args);
    }
};

// Global debug command object
Object.defineProperty(global, 'debugon', {
    get: function() {
        Memory.debug = true;
        console.log('Debug mode ENABLED');
        return 'Debug mode ENABLED';
    },
    configurable: true
});

Object.defineProperty(global, 'debugoff', {
    get: function() {
        Memory.debug = false;
        console.log('Debug mode DISABLED');
        return 'Debug mode DISABLED';
    },
    configurable: true
});


// Console help
Object.defineProperty(global, 'helpme', {
    get: function() {
        const text = `
=== Supported Mission Flags ===
[Combat]
- FlagRallyDefender : Rally point for defenders
- FlagAssembly      : Assembly point for squads
- FlagRallyCoy      : Rally point for decoys

[Economy/Expansion]
- FlagReserver*     : Starts reserver mission (e.g. FlagReserver1)
- FlagClaimer       : Starts claimer mission
- FlagBootstrap     : Starts bootstrap mission
- FlagRMining*      : Starts remote mining mission (e.g. FlagRMining1)

[Utility]
- FlagDismantle     : Target for dismantlers
- FlagBank          : Source room for MovingHouse
- FlagSink          : Destination room for MovingHouse
- FlagDrainer       : Target for drainers
- FlagVisual        : Enables room visuals
===============================
`;
        console.log(text);
        return 'Check console output.';
    }
});


// Global Room Cache heap
global.getRoomCache = function(room) {
    if (!room) return {};
    if (!room._cache || (room._cache && room._cache.time !== Game.time)) {
        const structures = room.find(FIND_STRUCTURES);
        const structuresByType = _.groupBy(structures, 'structureType');
        const dropped = room.find(FIND_DROPPED_RESOURCES);
        const ruins = room.find(FIND_RUINS);
        const myCreeps = room.find(FIND_MY_CREEPS);
        const constructionSites = room.find(FIND_CONSTRUCTION_SITES);
        const hostiles = room.find(FIND_HOSTILE_CREEPS);
        const hostileStructures = room.find(FIND_HOSTILE_STRUCTURES);
        
        room._cache = {
            structuresByType: structuresByType,
            dropped: dropped,
            ruins: ruins,
            myCreeps: myCreeps,
            constructionSites: constructionSites,
            hostiles: hostiles,
            hostileStructures: hostileStructures,
            time: Game.time
        };
    }
    return room._cache;
};

//module.exports.loop = function () {
// This line monkey patches the global prototypes.
//profiler.enable();
module.exports.loop = function() {
    //profiler.wrap(function() {
        // Main.js logic should go here.

        // --- Initialize Remote Memory ---
        if (!Memory.remoteRooms) Memory.remoteRooms = {};

        // --- Memory name garbage clearing ---
        for(var name in Memory.creeps) {
            if(!Game.creeps[name]) {
                delete Memory.creeps[name];
                log('Clearing non-existing creep memory:', name);
            }
        }
    
        // --- Run Mission Manager ---
        managerMission.run();
        managerRoomVisualizer.run();
        //libPathing.run();

        // --- CREEP RUN LOGIC ---
        // Run creep logic globally, as they may be in any room
        for(var name in Game.creeps) {
            var creep = Game.creeps[name];
            if(creep.memory.role == 'harvester') roleHarvester.run(creep);
            if(creep.memory.role == 'harvester_big') roleHarvesterBig.run(creep);
            if(creep.memory.role == 'hauler') roleHauler.run(creep);
            if(creep.memory.role == 'hauler_controller_special') roleHaulerControllerSpecial.run(creep);
            if(creep.memory.role == 'upgrader') roleUpgrader.run(creep);
            if(creep.memory.role == 'builder') roleBuilder.run(creep);
            if(creep.memory.role == 'defender') roleDefender.run(creep);
            if(creep.memory.role == 'scout') roleScout.run(creep);
            if(creep.memory.role == 'remote_harvester') roleRemoteHarvester.run(creep);
            if(creep.memory.role == 'mission_defender_range') roleMissionDefenderRange.run(creep);
            if(creep.memory.role == 'mission_decoy') roleMissionDecoy.run(creep);
            if(creep.memory.role == 'mission_range_healer') roleMissionRangeHealer.run(creep);
            if(creep.memory.role == 'mission_defender_tank') roleMissionDefenderTank.run(creep);
            if(creep.memory.role == 'mission_reserver') roleMissionReserver.run(creep);
            if(creep.memory.role == 'mission_claimer') roleMissionClaimer.run(creep);
            if(creep.memory.role == 'mission_dismantler') roleMissionDismantler.run(creep);
            if(creep.memory.role == 'mission_bootstrap') roleMissionBootstrap.run(creep);
            if(creep.memory.role == 'mission_hauler_interroom') roleMissionHaulerInterRoom.run(creep);
            if(creep.memory.role == 'mission_remote_harvester') roleMissionRemoteHarvester.run(creep);
            if(creep.memory.role == 'mission_remote_hauler') roleMissionRemoteHauler.run(creep);
            if(creep.memory.role == 'drainer') roleDrainer.run(creep);
        }

        // --- COLONY LOOP ---
        const allCreeps = Object.values(Game.creeps);

        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            
            // Check if this is a valid colony (Owned controller + Spawns)
            if (room.controller && room.controller.my) {
                // --- TOWER RUN LOGIC ---
                // Run towers per room to avoid iterating Game.structures (performance)
                const towers = room.find(FIND_MY_STRUCTURES, { filter: { structureType: STRUCTURE_TOWER } });
                for (const tower of towers) {
                    roleTower.run(tower);
                }

                const spawns = room.find(FIND_MY_SPAWNS);
                if (spawns.length > 0) {
                    // Run Colony Logic for this room
                    runColony.run(room, spawns[0], allCreeps);
                }
            }
        }
    //});
}
