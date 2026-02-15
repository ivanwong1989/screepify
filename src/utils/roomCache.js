function getRoomCache(room) {
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
}

module.exports = function registerRoomCache() {
    global.getRoomCache = getRoomCache;
};
