var roleUniversal = require('role.universal');
var roleDefender = require('role.defender');
var roleTower = require('role.tower');
var runColony = require('runColony');
var userMissions = require('userMissions');
var managerMarket = require('managers_overseer_manager.room.economy.market');
// Any modules that you use that modify the game's prototypes should be require'd
// before you require the profiler.
//const profiler = require('screeps-profiler');

const DEBUG_CATEGORIES = Object.freeze([
    'admiral',
    'general',
    'mission.build',
    'mission.decongest',
    'mission.dismantle',
    'mission.harvest',
    'mission.logistics',
    'mission.mineral',
    'mission.remote.build',
    'mission.remote.repair',
    'mission.remote.harvest',
    'mission.remote.haul',
    'mission.remote.reserve',
    'mission.repair',
    'mission.scout',
    'mission.tower',
    'mission.upgrade',
    'market',
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

function showMarketHelp() {
    const lines = [
        'market()                          - show this help',
        'market(\"status\")                   - show market auto-trade status',
        'market(\"on\") / market(\"off\")       - enable or disable auto-trading',
        'market(\"set\", { ... })             - patch global market settings',
        'market(\"room\", roomName, { ... })  - patch per-room overrides',
        'market(\"room\", roomName, \"on|off\") - enable/disable per-room trading',
        'market(\"room\", roomName, \"report\") - show mineral totals (ledger + terminal)',
        'example: market(\"set\", { stockTargets: { LO: 2000 }, buy: { LO: { maxPrice: 1.5 } } })',
        'example: market(\"set\", { stockTargets: { energy: 100000 }, sell: { energy: { minPrice: 0.01 } } })',
        'example: market(\"set\", { energyValue: 16, maxOverpayPct: 0.08, sellBufferPct: 0.05 })'
    ];
    for (const line of lines) console.log(line);
    return 'Done';
}

function collectRoomMineralTotals(room) {
    const totals = {};
    const addStore = (store) => {
        if (!store) return;
        for (const resourceType in store) {
            const amount = store[resourceType];
            if (amount > 0) totals[resourceType] = (totals[resourceType] || 0) + amount;
        }
    };
    addStore(room.storage && room.storage.store);
    addStore(room.terminal && room.terminal.store);
    return totals;
}

function marketReport(roomName) {
    const room = Game.rooms[roomName];
    if (!room) return `Unknown room: ${roomName}`;
    const ledger = room._resourceLedger || (room.memory.overseer && room.memory.overseer.resourceLedger);
    const totals = ledger && ledger.totals ? ledger.totals : collectRoomMineralTotals(room);
    const tracked = managerMarket.getTrackedResources(roomName);
    const stockTargets = managerMarket.getStockTargets(roomName);
    const lines = [];

    if (tracked.length > 0) {
        lines.push(`Tracked resources (${tracked.length}):`);
        tracked.sort().forEach(resourceType => {
            if (resourceType === RESOURCE_ENERGY) return;
            const total = totals[resourceType] || 0;
            const terminalAmount = room.terminal ? (room.terminal.store[resourceType] || 0) : 0;
            const target = stockTargets[resourceType] || 0;
            lines.push(`${resourceType}: total=${total} terminal=${terminalAmount} stockTarget=${target}`);
        });
    }

    const mineralKeys = Object.keys(totals).filter(r => r !== RESOURCE_ENERGY).sort();
    if (mineralKeys.length > 0) {
        lines.push('All minerals (ledger totals):');
        mineralKeys.forEach(resourceType => {
            lines.push(`${resourceType}: ${totals[resourceType] || 0}`);
        });
    } else {
        lines.push('No minerals recorded in ledger.');
    }

    lines.forEach(line => console.log(line));
    return `Reported minerals for ${roomName}`;
}

global.market = function(action, ...args) {
    const cmd = action ? ('' + action).trim().toLowerCase() : 'help';
    if (!cmd || cmd === 'help' || cmd === 'h') return showMarketHelp();

    if (cmd === 'status' || cmd === 's') {
        const msg = managerMarket.summarize();
        console.log(msg);
        return msg;
    }

    if (cmd === 'on' || cmd === 'enable') {
        managerMarket.applyPatch({ enabled: true });
        const msg = managerMarket.summarize();
        console.log(msg);
        return msg;
    }

    if (cmd === 'off' || cmd === 'disable') {
        managerMarket.applyPatch({ enabled: false });
        const msg = managerMarket.summarize();
        console.log(msg);
        return msg;
    }

    if (cmd === 'set') {
        const patch = args[0];
        if (!patch || typeof patch !== 'object') return 'Usage: market(\"set\", { ... })';
        managerMarket.applyPatch(patch);
        const msg = managerMarket.summarize();
        console.log(msg);
        return msg;
    }

    if (cmd === 'room') {
        const roomName = args[0];
        if (!roomName) return 'Usage: market(\"room\", \"W1N1\", { ... })';
        const patch = args[1];
        if (patch === 'report' || patch === 'ledger') {
            return marketReport(roomName);
        }
        if (patch === 'on' || patch === 'off') {
            managerMarket.applyRoomPatch(roomName, { enabled: patch === 'on' });
        } else if (patch && typeof patch === 'object') {
            managerMarket.applyRoomPatch(roomName, patch);
        }
        const msg = managerMarket.summarizeRoom(roomName);
        console.log(msg);
        return msg;
    }

    return showMarketHelp();
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

function getOwnedSpawnRoomsForMissionCreate() {
    const cache = global._ownedSpawnRoomsCache;
    if (cache && cache.time === Game.time) return cache.rooms;

    const owned = [];
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room || !room.controller || !room.controller.my) continue;
        const roomCache = global.getRoomCache(room);
        const spawns = roomCache.myStructuresByType[STRUCTURE_SPAWN] || [];
        if (spawns.length > 0) owned.push(roomName);
    }

    global._ownedSpawnRoomsCache = { time: Game.time, rooms: owned };
    return owned;
}

function resolveSponsorRoomForTargetPos(targetPos) {
    if (!targetPos || !targetPos.roomName) return null;
    const ownedRooms = getOwnedSpawnRoomsForMissionCreate();
    if (!ownedRooms || ownedRooms.length === 0) return null;
    const ownedSet = new Set(ownedRooms);
    if (ownedSet.has(targetPos.roomName)) return targetPos.roomName;

    let bestRoom = ownedRooms[0];
    let bestDist = Game.map.getRoomLinearDistance(targetPos.roomName, bestRoom);
    for (let i = 1; i < ownedRooms.length; i++) {
        const roomName = ownedRooms[i];
        const dist = Game.map.getRoomLinearDistance(targetPos.roomName, roomName);
        if (dist < bestDist) {
            bestDist = dist;
            bestRoom = roomName;
        }
    }
    return bestRoom;
}

function resolveSponsorRoomForTargetRoom(targetRoom) {
    const roomName = userMissions.normalizeRoomName(targetRoom);
    if (!roomName) return null;
    const ownedRooms = getOwnedSpawnRoomsForMissionCreate();
    if (!ownedRooms || ownedRooms.length === 0) return null;
    const ownedSet = new Set(ownedRooms);
    if (ownedSet.has(roomName)) return roomName;

    let bestRoom = ownedRooms[0];
    let bestDist = Game.map.getRoomLinearDistance(roomName, bestRoom);
    for (let i = 1; i < ownedRooms.length; i++) {
        const candidate = ownedRooms[i];
        const dist = Game.map.getRoomLinearDistance(roomName, candidate);
        if (dist < bestDist) {
            bestDist = dist;
            bestRoom = candidate;
        }
    }
    return bestRoom;
}

function tryResolveTargetIdForPos(targetPos) {
    if (!targetPos || !targetPos.roomName) return null;
    const room = Game.rooms[targetPos.roomName];
    if (!room) return null;
    const pos = new RoomPosition(Number(targetPos.x), Number(targetPos.y), targetPos.roomName);
    const structures = pos.lookFor(LOOK_STRUCTURES);
    if (!structures || structures.length === 0) return null;
    return structures[0].id;
}

function formatMissionTarget(pos, targetRoom) {
    if (pos && pos.roomName !== undefined && pos.x !== undefined && pos.y !== undefined) {
        return `${pos.roomName}:${pos.x},${pos.y}`;
    }
    if (targetRoom) return targetRoom;
    return 'n/a';
}

function listUserMissions() {
    const all = userMissions.getAll();
    if (all.length === 0) {
        console.log('No user missions.');
        return 'No user missions.';
    }
    console.log(`User missions (${all.length}):`);
    for (const m of all) {
        const enabled = m.enabled === false ? 'off' : 'on';
        const target = formatMissionTarget(m.targetPos, m.targetRoom);
        const sponsor = m.sponsorRoom || '(auto)';
        const label = m.label ? ` label="${m.label}"` : '';
        console.log(`${m.id} type=${m.type} ${enabled} sponsor=${sponsor} target=${target} priority=${m.priority}${label}`);
    }
    return `Listed ${all.length} user missions.`;
}

function showMissionHelp() {
    const defs = userMissions.getDefinitions();
    const types = Object.keys(defs);
    const lines = [
        'mission()                         - show this help',
        'mission("types")                  - list available user mission types',
        'mission("list")                   - list user missions',
        'mission("add","dismantle", room, x, y, sponsorRoom?, priority?, persist?, label?)',
        'mission("add","dismantle", { roomName, x, y, sponsorRoom, priority, persist, label })',
        'mission("add","reserve", roomName, sponsorRoom?, priority?, persist?, label?)',
        'mission("add","reserve", { roomName, sponsorRoom, priority, persist, label })',
        'mission("set", id, { sponsorRoom, priority, persist, label, x, y, roomName, targetRoom })',
        'mission("enable", id) / mission("disable", id)',
        'mission("remove", id)',
        `available types: ${types.join(', ') || '(none)'}`
    ];
    for (const line of lines) console.log(line);
    return 'Done';
}

function normalizeMissionPatch(patch) {
    if (!patch || typeof patch !== 'object') return null;
    const next = {};
    if ('enabled' in patch) next.enabled = patch.enabled === false ? false : true;
    if ('priority' in patch) {
        const priority = Number(patch.priority);
        if (Number.isFinite(priority)) next.priority = priority;
    }
    if ('sponsorRoom' in patch) {
        const sponsor = userMissions.normalizeRoomName(patch.sponsorRoom);
        next.sponsorRoom = sponsor || null;
    }
    if ('persist' in patch) {
        const raw = patch.persist;
        const persist = (raw === true || raw === 'true' || raw === 1 || raw === '1' || raw === 'yes' || raw === 'y');
        next.persist = persist;
    }
    if ('label' in patch) next.label = patch.label ? ('' + patch.label).trim() : '';
    if ('targetId' in patch) next.targetId = patch.targetId ? ('' + patch.targetId).trim() : null;
    if ('roomName' in patch || 'targetRoom' in patch) {
        const targetRoom = userMissions.normalizeRoomName(patch.roomName || patch.targetRoom);
        next.targetRoom = targetRoom || null;
    }

    const posInput = patch.targetPos || patch.pos || patch.target || patch;
    const pos = userMissions.normalizeTargetPos(posInput);
    if (pos) {
        next.targetPos = pos;
        if (!next.targetRoom) next.targetRoom = pos.roomName;
    }

    return next;
}

global.mission = function(action, typeOrData, ...args) {
    const cmd = action ? ('' + action).trim().toLowerCase() : 'help';
    if (!cmd || cmd === 'help' || cmd === 'h') return showMissionHelp();

    if (cmd === 'types') {
        const defs = userMissions.getDefinitions();
        const keys = Object.keys(defs);
        if (keys.length === 0) return 'No mission types registered.';
        for (const key of keys) {
            const def = defs[key];
            const req = (def.required || []).join(', ');
            const opt = (def.optional || []).join(', ');
            console.log(`${key}: ${def.label || ''} required=[${req}] optional=[${opt}]`);
        }
        return `Types: ${keys.join(', ')}`;
    }

    if (cmd === 'list' || cmd === 'ls') {
        return listUserMissions();
    }

    if (cmd === 'add') {
        let type = null;
        let data = null;
        if (typeOrData && typeof typeOrData === 'object') {
            data = typeOrData;
            type = data.type;
        } else {
            type = typeOrData;
        }
        const key = type ? ('' + type).trim().toLowerCase() : '';
        if (!key) return 'Usage: mission("add", "dismantle", room, x, y, sponsorRoom?, priority?, persist?, label?) OR mission("add", "reserve", roomName, sponsorRoom?, priority?, persist?, label?)';

        if (!data) {
            if (key === 'dismantle') {
                data = {
                    roomName: args[0],
                    x: args[1],
                    y: args[2],
                    sponsorRoom: args[3],
                    priority: args[4],
                    persist: args[5],
                    label: args[6]
                };
            } else if (key === 'reserve') {
                data = {
                    roomName: args[0],
                    sponsorRoom: args[1],
                    priority: args[2],
                    persist: args[3],
                    label: args[4]
                };
            } else {
                data = {};
            }
        }

        if (key === 'dismantle') {
            const targetPos = userMissions.normalizeTargetPos(data.targetPos || data);
            if (targetPos) {
                if (!data.sponsorRoom) {
                    const sponsorRoom = resolveSponsorRoomForTargetPos(targetPos);
                    if (sponsorRoom) data.sponsorRoom = sponsorRoom;
                }
                if (!data.targetId) {
                    const targetId = tryResolveTargetIdForPos(targetPos);
                    if (targetId) data.targetId = targetId;
                }
            }
        } else if (key === 'reserve') {
            if (!data.sponsorRoom) {
                const sponsorRoom = resolveSponsorRoomForTargetRoom(data.roomName || data.targetRoom);
                if (sponsorRoom) data.sponsorRoom = sponsorRoom;
            }
        }

        const result = userMissions.addMission(key, data);
        if (result && result.error) return result.error;
        const mission = result.mission;
        console.log(`Added mission ${mission.id} type=${mission.type} target=${formatMissionTarget(mission.targetPos, mission.targetRoom)}`);
        return mission.id;
    }

    if (cmd === 'set' || cmd === 'update') {
        const id = typeOrData ? ('' + typeOrData).trim() : '';
        const patch = normalizeMissionPatch(args[0]);
        if (!id || !patch) return 'Usage: mission("set", id, { sponsorRoom, priority, persist, label, x, y, roomName, targetRoom })';
        const updated = userMissions.updateMission(id, patch);
        if (!updated) return `Unknown mission id: ${id}`;
        return `Updated mission ${id}`;
    }

    if (cmd === 'enable' || cmd === 'disable') {
        const id = typeOrData ? ('' + typeOrData).trim() : '';
        if (!id) return `Usage: mission("${cmd}", id)`;
        const updated = userMissions.updateMission(id, { enabled: cmd === 'enable' });
        if (!updated) return `Unknown mission id: ${id}`;
        return `${cmd}d mission ${id}`;
    }

    if (cmd === 'remove' || cmd === 'rm' || cmd === 'del') {
        const id = typeOrData ? ('' + typeOrData).trim() : '';
        if (!id) return 'Usage: mission("remove", id)';
        const removed = userMissions.removeMission(id);
        return removed ? `Removed mission ${id}` : `Unknown mission id: ${id}`;
    }

    return showMissionHelp();
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
            'market()          - manage terminal auto-trading',
            'allyAdd(\"Name\")    - add an ally by player name',
            'allyRemove(\"Name\") - remove an ally by player name',
            'allyList()        - show current allies',
            'mission()         - manage user-controlled missions',
            'flag directives:',
            '  Parking*        - decongest parking flags',
            '  Dismantle flags are deprecated; use mission()'
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
            } else if(['universal', 'miner', 'mineral_miner', 'mobile_miner', 'scout', 'hauler', 'upgrader', 'builder', 'repairer', 'worker', 'remote_worker', 'dismantler', 'reserver'].includes(creep.memory.role)) {
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

    //});
}
