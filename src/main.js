var roleUniversal = require('role.universal');
var roleDefender = require('role.defender');
var roleTower = require('role.tower');
var runColony = require('runColony');
// Any modules that you use that modify the game's prototypes should be require'd
// before you require the profiler.
const profiler = require('screeps-profiler');

const DEBUG_CATEGORIES = Object.freeze([
    'admiral',
    'general',
    'mission.build',
    'mission.decongest',
    'mission.dismantle',
    'mission.harvest',
    'mission.logistics',
    'mission.mineral',
    'mission.repair',
    'mission.scout',
    'mission.tower',
    'mission.upgrade',
    'overseer',
    'overseer.ledger',
    'spawner',
    'system'
]);

function registerDebugCategory(category) {
    if (!global._debugCategorySet) global._debugCategorySet = new Set();
    global._debugCategorySet.add(category);
}

function getAvailableDebugCategories() {
    const list = new Set(DEBUG_CATEGORIES);
    const cats = Memory.debugCategories;
    if (cats && typeof cats === 'object') {
        for (const key of Object.keys(cats)) list.add(key);
    }
    if (global._debugCategorySet instanceof Set) {
        for (const key of global._debugCategorySet) list.add(key);
    }
    return Array.from(list).sort();
}


// Debug logger with optional category filtering.
// If Memory.debugCategories has keys, only those categories will log.
global.debug = function(category, ...args) {
    registerDebugCategory(category);
    if (!Memory.debug) return;
    const cats = Memory.debugCategories;
    if (cats && typeof cats === 'object') {
        if (!cats[category]) return;
    }
    console.log(...args);
};

// Backward-compatible logger (general category)
global.log = function(...args) {
    global.debug('general', ...args);
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
        Memory.debugMissions = true;
        console.log('Debug mode ENABLED');
        return 'Debug mode ENABLED';
    },
    configurable: true
});

Object.defineProperty(global, 'debugoff', {
    get: function() {
        delete Memory.debug;
        delete Memory.debugMissions;
        delete Memory.debugCategories;
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
        delete Memory.debugCombat;
        console.log('Combat Debug mode DISABLED');
        return 'Combat Debug mode DISABLED';
    },
    configurable: true
});

function ensureDebugCategories() {
    if (!Memory.debugCategories || typeof Memory.debugCategories !== 'object') {
        Memory.debugCategories = {};
    }
    return Memory.debugCategories;
}

global.debugcaton = function(name) {
    const key = ('' + name).trim();
    if (!key) return 'Usage: debugcaton(\"category\")';
    Memory.debug = true;
    const cats = ensureDebugCategories();
    cats[key] = true;
    return `Debug categories enabled: ${Object.keys(cats).filter(k => cats[k]).sort().join(', ') || '(none)'}`;
};

global.debugcatoff = function(name) {
    const key = ('' + name).trim();
    if (!key) return 'Usage: debugcatoff(\"category\")';
    const cats = ensureDebugCategories();
    delete cats[key];
    return `Debug categories enabled: ${Object.keys(cats).filter(k => cats[k]).sort().join(', ') || '(none)'}`;
};

global.debugcats = function() {
    const available = getAvailableDebugCategories();
    if (!Memory.debugCategories || typeof Memory.debugCategories !== 'object') {
        return `Debug categories enabled: (all) | available: ${available.join(', ') || '(none)'}`;
    }
    const enabled = Object.keys(Memory.debugCategories).filter(k => Memory.debugCategories[k]).sort();
    return `Debug categories enabled: ${enabled.join(', ') || '(none)'} | available: ${available.join(', ') || '(none)'}`;
};

global.debugall = function() {
    Memory.debug = true;
    delete Memory.debugCategories;
    return 'Debug categories cleared (all enabled)';
};

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
            'debugcaton(\"cat\")  - enable a debug category (allowlist)',
            'debugcatoff(\"cat\") - disable a debug category',
            'debugcats()       - list enabled and available debug categories',
            'debugall          - clear category filter (log all)',
            'allyAdd(\"Name\")    - add an ally by player name',
            'allyRemove(\"Name\") - remove an ally by player name',
            'allyList()        - show current allies',
            'flag directives:',
            '  RED/PURPLE      - dismantle (optional flag.memory: sponsorRoom, priority, persist)'
        ];
        for (const line of lines) console.log(line);
        return `Done`;
    },
    configurable: true
});

// Global Room Cache heap
global.getRoomCache = function(room) {
    if (!room) return {};
    if (!room._cache) room._cache = {};

    const cache = room._cache;
    const now = Game.time;
    const staticInterval = 50;

    if (!Array.isArray(Memory.allies)) Memory.allies = [];
    const allies = Memory.allies.map(a => ('' + a).toLowerCase());
    const isAlly = (owner) => !!(owner && owner.username && allies.includes(owner.username.toLowerCase()));

    let staticRefreshed = false;
    if (!cache.static || (cache.static.time + staticInterval) <= now) {
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
        const flags = room.find(FIND_FLAGS);
        const sources = room.find(FIND_SOURCES);
        const minerals = room.find(FIND_MINERALS);
        const hostileStructuresAll = room.find(FIND_HOSTILE_STRUCTURES);

        cache.static = {
            structures: structures,
            structuresByType: structuresByType,
            myStructures: myStructures,
            myStructuresByType: myStructuresByType,
            flags: flags,
            sources: sources,
            minerals: minerals,
            hostileStructuresAll: hostileStructuresAll,
            time: now
        };
        staticRefreshed = true;
    }

    if (!cache.dynamic || cache.dynamic.time !== now || staticRefreshed) {
        const creeps = room.find(FIND_CREEPS);
        const myCreeps = creeps.filter(c => c.my);
        const hostiles = creeps.filter(c => !c.my && !isAlly(c.owner));
        const dropped = room.find(FIND_DROPPED_RESOURCES);
        const ruins = room.find(FIND_RUINS);
        const tombstones = room.find(FIND_TOMBSTONES);
        const constructionSites = room.find(FIND_CONSTRUCTION_SITES);
        const hostileStructures = cache.static.hostileStructuresAll.filter(s => !isAlly(s.owner));
        const sourcesActive = cache.static.sources.filter(s => s.energy > 0);

        cache.dynamic = {
            creeps: creeps,
            myCreeps: myCreeps,
            hostiles: hostiles,
            dropped: dropped,
            ruins: ruins,
            tombstones: tombstones,
            constructionSites: constructionSites,
            hostileStructures: hostileStructures,
            sourcesActive: sourcesActive,
            time: now
        };
    }

    if (!cache.current || cache.current.time !== now || staticRefreshed) {
        cache.current = Object.assign({}, cache.static, cache.dynamic, {
            time: now,
            staticTime: cache.static.time,
            dynamicTime: cache.dynamic.time
        });
    }

    return cache.current;
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

        // --- CREEP RUN LOGIC ---
        // Run creep logic globally, as they may be in any room
        for(var name in Game.creeps) {
            var creep = Game.creeps[name];
            if (creep.memory.role === 'defender' || creep.memory.role === 'brawler') {
                roleDefender.run(creep);
            } else if(['universal', 'miner', 'mineral_miner', 'mobile_miner', 'scout', 'hauler', 'upgrader', 'builder', 'repairer', 'worker', 'dismantler'].includes(creep.memory.role)) {
                roleUniversal.run(creep);
            }
        }

        // 1. Configuration: How many ticks to average over
        const EMA_WINDOW = 20; // The 'X' ticks

        // 2. Get the CPU used this tick
        const cpuUsed = Game.cpu.getUsed();

        // 3. Initialize memory if it doesn't exist
        if (Memory.avgCpu === undefined) {
            Memory.avgCpu = cpuUsed;
        }

        // 4. Update the Moving Average
        // Formula: (OldAvg * (X-1) + NewValue) / X
        Memory.avgCpu = (Memory.avgCpu * (EMA_WINDOW - 1) + cpuUsed) / EMA_WINDOW;

        // 5. Output to console (optional)
        if (Game.time % 10 === 0) {
            console.log(`Average CPU over ${EMA_WINDOW} ticks: ${Memory.avgCpu.toFixed(2)}`);
        }

    });
}
