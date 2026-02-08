var roleUniversal = require('role.universal');
var runColony = require('runColony');
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

        // --- CREEP RUN LOGIC ---
        // Run creep logic globally, as they may be in any room
        for(var name in Game.creeps) {
            var creep = Game.creeps[name];
            if(creep.memory.role == 'universal') roleUniversal.run(creep);
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
