function getRoomCache(room) {
    if (!room) return {};
    if (!room._cache) room._cache = {};

    // Initialize heap cache if not present
    if (!global._roomCache) global._roomCache = {};
    if (!global._roomCache[room.name]) global._roomCache[room.name] = {};

    const cache = room._cache; // Local tick cache (on room object)
    const heap = global._roomCache[room.name]; // Heap cache (persistent)
    const now = Game.time;
    const staticInterval = 15;

    if (!Array.isArray(Memory.allies)) Memory.allies = [];
    const allies = Memory.allies.map(a => ('' + a).toLowerCase());
    const isAlly = (owner) => !!(owner && owner.username && allies.includes(owner.username.toLowerCase()));

    // Refresh static IDs in heap if expired
    if (!heap.static || (heap.static.time + staticInterval) <= now) {
        console.log(`static refreshed ${room.name}`);
        const structures = room.find(FIND_STRUCTURES);
        const flags = room.find(FIND_FLAGS);
        const sources = room.find(FIND_SOURCES);
        const minerals = room.find(FIND_MINERALS);
        const hostileStructuresAll = room.find(FIND_HOSTILE_STRUCTURES);

        heap.static = {
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
        const s = heap.static;
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
