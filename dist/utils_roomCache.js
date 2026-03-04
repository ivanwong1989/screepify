const heap = require('utils_heap');

function getRoomCache(room) {
    if (!room) return {};
    if (!room._cache) room._cache = {};
    // Heap cache (volatile, rebuilt on VM reset)
    const roomsHeap = heap.getStore('roomCache');
    if (!roomsHeap[room.name]) roomsHeap[room.name] = Object.create(null);

    const cache = room._cache; // Local tick cache (on room object)
    const heapRoom = roomsHeap[room.name]; // Heap cache (persistent for this VM)
    const now = Game.time;
    // --- Hostile movement tracking (heap, short-lived) ---
    // Used by combatMatrix prediction to bias enemy "next tile".
    const enemyLastPos = heap.getStore('enemyLastPos');
    // --- HARD INVALIDATION PER TICK ---
    // If room._cache persists across ticks for any reason, force refresh.
    if (cache.dynamic && cache.dynamic.time !== now) delete cache.dynamic;
    if (cache.current && cache.current.time !== now) delete cache.current;

    // Static hydration should track heapRoom.static.time (not Game.time)
    if (cache.static && heapRoom.static && cache.static.time !== heapRoom.static.time) delete cache.static;
    
    const staticInterval = 15;

    if (!Array.isArray(Memory.allies)) Memory.allies = [];
    const allies = Memory.allies.map(a => ('' + a).toLowerCase());
    const isAlly = (owner) => !!(owner && owner.username && allies.includes(owner.username.toLowerCase()));

    // Refresh static IDs in heap if expired
    if (!heapRoom.static || (heapRoom.static.time + staticInterval) <= now) {
        debug('roomCache', `[RoomCache] Static refreshed ${room.name}`);
        const structures = room.find(FIND_STRUCTURES);
        const flags = room.find(FIND_FLAGS);
        const sources = room.find(FIND_SOURCES);
        const minerals = room.find(FIND_MINERALS);
        const hostileStructuresAll = room.find(FIND_HOSTILE_STRUCTURES);

        heapRoom.static = {
            structureIds: structures.map(s => s.id),
            flagNames: flags.map(f => f.name),
            sourceIds: sources.map(s => s.id),
            mineralIds: minerals.map(m => m.id),
            hostileStructureIds: hostileStructuresAll.map(s => s.id),
            time: now
        };
    }

    // Hydrate static objects for the current tick
    if (!cache.static) {
        const s = heapRoom.static;
        const getById = (id) => Game.getObjectById(id);

        const structures = s.structureIds.map(getById).filter(o => o);
        const sources = s.sourceIds.map(getById).filter(o => o);
        const minerals = s.mineralIds.map(getById).filter(o => o);
        const hostileStructuresAll = s.hostileStructureIds.map(getById).filter(o => o);
        const flags = s.flagNames.map(name => Game.flags[name]).filter(f => f && f.pos.roomName === room.name);

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

        cache.static = {
            structures,
            structuresByType,
            myStructures,
            myStructuresByType,
            flags,
            sources,
            minerals,
            hostileStructuresAll,
            time: s.time
        };
    }

    // Dynamic Cache (per tick)
    if (!cache.dynamic) {
        const creeps = room.find(FIND_CREEPS);
        const myCreeps = creeps.filter(c => c.my);
        const hostiles = creeps.filter(c => !c.my && !isAlly(c.owner));

        // Track last hostile positions (for 1-tick motion vector prediction)
        try {
            const map = enemyLastPos;
            // light pruning: every 50 ticks, drop entries older than 5 ticks
            if (now % 50 === 0) {
                for (const id in map) {
                    const rec = map[id];
                    if (!rec || (now - rec.time) > 5) delete map[id];
                }
            }
            for (const h of hostiles) {
                if (!h || !h.id || !h.pos) continue;
                const existing = map[h.id];
                map[h.id] = { x: h.pos.x, y: h.pos.y, roomName: h.pos.roomName, time: now, prev: existing && existing.time === now - 1 ? { x: existing.x, y: existing.y, roomName: existing.roomName, time: existing.time } : (existing && existing.prev ? existing.prev : null) };
            }
        } catch (e) {
            // do nothing
        }
        const dropped = room.find(FIND_DROPPED_RESOURCES);
        const ruins = room.find(FIND_RUINS);
        const tombstones = room.find(FIND_TOMBSTONES);
        const constructionSites = room.find(FIND_CONSTRUCTION_SITES);
        const hostileStructures = cache.static.hostileStructuresAll.filter(s => !isAlly(s.owner));
        const sourcesActive = cache.static.sources.filter(s => s.energy > 0);

        cache.dynamic = {
            creeps,
            myCreeps,
            hostiles,
            dropped,
            ruins,
            tombstones,
            constructionSites,
            hostileStructures,
            sourcesActive,
            time: now
        };
    }

    if (!cache.current) {
        cache.current = Object.assign({}, cache.static, cache.dynamic, {
            time: now,
            staticTime: cache.static.time,
            dynamicTime: cache.dynamic.time
        });
    }

    return cache.current;
}

module.exports = function registerRoomCache() {
    global.getRoomCache = getRoomCache;
};
