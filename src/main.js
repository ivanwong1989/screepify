var roleUniversal = require('role.universal');
var roleDefender = require('role.defender');
var roleTower = require('role.tower');
var runColony = require('runColony');
// Any modules that you use that modify the game's prototypes should be require'd
// before you require the profiler.
const profiler = require('screeps-profiler');


// A simple, reliable custom logger
global.log = function(...args) {
    if (Memory.debug) {
        console.log(...args);
    }
};

// Combat logger
global.logCombat = function(...args) {
    if (Memory.debugCombat) {
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

Object.defineProperty(global, 'debugoncombat', {
    get: function() {
        Memory.debugCombat = true;
        console.log('Combat Debug mode ENABLED');
        return 'Combat Debug mode ENABLED';
    },
    configurable: true
});

Object.defineProperty(global, 'debugoffcombat', {
    get: function() {
        Memory.debugCombat = false;
        console.log('Combat Debug mode DISABLED');
        return 'Combat Debug mode DISABLED';
    },
    configurable: true
});

// Console helpers
function normalizeAllyName(name) {
    if (name === undefined || name === null) return '';
    return ('' + name).trim();
}

function ensureAllies() {
    if (!Array.isArray(Memory.allies)) Memory.allies = [];
    return Memory.allies;
}

global.allyAdd = function(name) {
    const raw = normalizeAllyName(name);
    if (!raw) return 'Usage: allyAdd(\"PlayerName\")';
    const allies = ensureAllies();
    const exists = allies.some(a => ('' + a).toLowerCase() === raw.toLowerCase());
    if (!exists) allies.push(raw);
    return `Allies: ${JSON.stringify(allies)}`;
};

global.allyRemove = function(name) {
    const raw = normalizeAllyName(name);
    if (!raw) return 'Usage: allyRemove(\"PlayerName\")';
    const allies = ensureAllies();
    const filtered = allies.filter(a => ('' + a).toLowerCase() !== raw.toLowerCase());
    Memory.allies = filtered;
    return `Allies: ${JSON.stringify(Memory.allies)}`;
};

global.allyList = function() {
    const allies = ensureAllies();
    return `Allies: ${JSON.stringify(allies)}`;
};

Object.defineProperty(global, 'help', {
    get: function() {
        const lines = [
            'Console commands:',
            'debugon           - enable debug logging',
            'debugoff          - disable debug logging',
            'debugoncombat     - enable combat debug logging',
            'debugoffcombat    - disable combat debug logging',
            'allyAdd(\"Name\")    - add an ally by player name',
            'allyRemove(\"Name\") - remove an ally by player name',
            'allyList()        - show current allies'
        ];
        for (const line of lines) console.log(line);
        return `Done`;
    },
    configurable: true
});

// Global Room Cache heap
global.getRoomCache = function(room) {
    if (!room) return {};
    if (!room._cache || (room._cache && room._cache.time !== Game.time)) {
        if (!Array.isArray(Memory.allies)) Memory.allies = [];
        const allies = Memory.allies.map(a => ('' + a).toLowerCase());
        const isAlly = (owner) => !!(owner && owner.username && allies.includes(owner.username.toLowerCase()));
        const structures = room.find(FIND_STRUCTURES);
        const structuresByType = structures.reduce((acc, s) => {
            acc[s.structureType] = acc[s.structureType] || [];
            acc[s.structureType].push(s);
            return acc;
        }, {});
        const myStructures = structures.filter(s => s.my);
        const myStructuresByType = myStructures.reduce((acc, s) => {
            acc[s.structureType] = acc[s.structureType] || [];
            acc[s.structureType].push(s);
            return acc;
        }, {});
        const dropped = room.find(FIND_DROPPED_RESOURCES);
        const ruins = room.find(FIND_RUINS);
        const tombstones = room.find(FIND_TOMBSTONES);
        const creeps = room.find(FIND_CREEPS);
        const myCreeps = creeps.filter(c => c.my);
        const constructionSites = room.find(FIND_CONSTRUCTION_SITES);
        const hostiles = creeps.filter(c => !c.my && !isAlly(c.owner));
        const hostileStructures = room.find(FIND_HOSTILE_STRUCTURES).filter(s => !isAlly(s.owner));
        const flags = room.find(FIND_FLAGS);
        const sources = room.find(FIND_SOURCES);
        const minerals = room.find(FIND_MINERALS);
        const sourcesActive = sources.filter(s => s.energy > 0);
        
        room._cache = {
            structures: structures,
            structuresByType: structuresByType,
            myStructures: myStructures,
            myStructuresByType: myStructuresByType,
            dropped: dropped,
            ruins: ruins,
            tombstones: tombstones,
            creeps: creeps,
            myCreeps: myCreeps,
            constructionSites: constructionSites,
            hostiles: hostiles,
            hostileStructures: hostileStructures,
            flags: flags,
            sources: sources,
            minerals: minerals,
            sourcesActive: sourcesActive,
            time: Game.time
        };
    }
    return room._cache;
};


// This line monkey patches the global prototypes.
profiler.enable();
module.exports.loop = function() {
    profiler.wrap(function() {
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

        // --- CREEP RUN LOGIC ---
        // Run creep logic globally, as they may be in any room
        for(var name in Game.creeps) {
            var creep = Game.creeps[name];
            if (creep.memory.role === 'defender' || creep.memory.role === 'brawler') {
                roleDefender.run(creep);
            } else if(['universal', 'miner', 'mineral_miner', 'mobile_miner', 'hauler', 'upgrader', 'builder', 'repairer', 'worker'].includes(creep.memory.role)) {
                roleUniversal.run(creep);
            }
        }
    });
}
