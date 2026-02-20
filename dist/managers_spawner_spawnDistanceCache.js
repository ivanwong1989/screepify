const CACHE_VERSION = 1;
const DEFAULT_REMOVAL_GRACE_TICKS = 500;
const DEFAULT_MAX_PAIRS_PER_TICK = 2;

function getCache() {
    if (!Memory.globalSpawner) Memory.globalSpawner = {};
    const cache = Memory.globalSpawner.spawnDistV1;
    if (!cache || cache.version !== CACHE_VERSION) {
        Memory.globalSpawner.spawnDistV1 = {
            version: CACHE_VERSION,
            spawns: {},
            dist: {},
            queue: []
        };
    }
    return Memory.globalSpawner.spawnDistV1;
}

function listMySpawns() {
    const result = [];
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room || !room.controller || !room.controller.my) continue;
        const spawns = room.find(FIND_MY_SPAWNS);
        for (const spawn of spawns) {
            result.push(spawn);
        }
    }
    return result;
}

function syncSpawnRegistry(options) {
    const cache = getCache();
    const removalGraceTicks = options && options.removalGraceTicks
        ? options.removalGraceTicks
        : DEFAULT_REMOVAL_GRACE_TICKS;
    const currentSpawns = listMySpawns();
    const seen = Object.create(null);

    for (const spawn of currentSpawns) {
        const id = spawn.id;
        seen[id] = true;
        if (!cache.spawns[id]) {
            cache.spawns[id] = {
                name: spawn.name,
                roomName: spawn.room.name,
                x: spawn.pos.x,
                y: spawn.pos.y,
                lastSeen: Game.time
            };
        } else {
            const entry = cache.spawns[id];
            entry.name = spawn.name;
            entry.roomName = spawn.room.name;
            entry.x = spawn.pos.x;
            entry.y = spawn.pos.y;
            entry.lastSeen = Game.time;
        }
    }

    for (const spawnId in cache.spawns) {
        if (seen[spawnId]) continue;
        const lastSeen = cache.spawns[spawnId].lastSeen || 0;
        if (Game.time - lastSeen > removalGraceTicks) {
            delete cache.spawns[spawnId];
            delete cache.dist[spawnId];
            for (const otherId in cache.dist) {
                if (cache.dist[otherId]) {
                    delete cache.dist[otherId][spawnId];
                }
            }
        }
    }
}

function enqueueMissingPairs(options) {
    const cache = getCache();
    const spawnIds = Object.keys(cache.spawns);
    if (!cache.queue) cache.queue = [];

    const queued = new Set();
    for (const entry of cache.queue) {
        if (!entry || !entry.a || !entry.b) continue;
        const key = entry.a < entry.b ? `${entry.a}|${entry.b}` : `${entry.b}|${entry.a}`;
        queued.add(key);
    }

    for (let i = 0; i < spawnIds.length; i++) {
        const a = spawnIds[i];
        if (!cache.dist[a]) cache.dist[a] = {};
        for (let j = i + 1; j < spawnIds.length; j++) {
            const b = spawnIds[j];
            if (cache.dist[a][b] !== undefined) continue;
            const key = a < b ? `${a}|${b}` : `${b}|${a}`;
            if (queued.has(key)) continue;
            cache.queue.push({ a, b });
            queued.add(key);
        }
    }
}

function computeSpawnToSpawnDistance(spawnA, spawnB) {
    if (!spawnA || !spawnB) return null;
    if (spawnA.room.name === spawnB.room.name) {
        const ret = PathFinder.search(spawnA.pos, { pos: spawnB.pos, range: 1 }, {
            maxOps: 2000,
            plainCost: 2,
            swampCost: 10
        });
        return {
            rooms: 0,
            stepsApprox: ret.path.length,
            computedAt: Game.time
        };
    }

    const roomA = spawnA.room.name;
    const roomB = spawnB.room.name;
    const route = Game.map.findRoute(roomA, roomB, {
        routeCallback: (roomName) => {
            if (roomName !== roomA && roomName !== roomB) {
                if (Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].avoid) {
                    return Number.POSITIVE_INFINITY;
                }
            }
            return 1;
        }
    });

    if (route === ERR_NO_PATH || !Array.isArray(route)) {
        return null;
    }

    const rooms = route.length;
    return {
        rooms,
        stepsApprox: rooms * 50,
        computedAt: Game.time
    };
}

function processQueue(options) {
    const cache = getCache();
    const maxPairsPerTick = options && options.maxPairsPerTick
        ? options.maxPairsPerTick
        : DEFAULT_MAX_PAIRS_PER_TICK;
    if (!cache.queue || cache.queue.length === 0) return;

    let processed = 0;
    while (processed < maxPairsPerTick && cache.queue.length > 0) {
        const pair = cache.queue.shift();
        if (!pair || !pair.a || !pair.b) continue;
        const spawnA = Game.getObjectById(pair.a);
        const spawnB = Game.getObjectById(pair.b);
        const result = computeSpawnToSpawnDistance(spawnA, spawnB);

        if (!cache.dist[pair.a]) cache.dist[pair.a] = {};
        if (!cache.dist[pair.b]) cache.dist[pair.b] = {};
        cache.dist[pair.a][pair.b] = result;
        cache.dist[pair.b][pair.a] = result;
        processed++;
    }
}

function getDistance(spawnIdA, spawnIdB) {
    if (!spawnIdA || !spawnIdB) return undefined;
    if (spawnIdA === spawnIdB) {
        return { rooms: 0, stepsApprox: 0, computedAt: Game.time };
    }
    const cache = getCache();
    if (!cache.dist[spawnIdA]) return undefined;
    return cache.dist[spawnIdA][spawnIdB];
}

module.exports = {
    syncSpawnRegistry,
    enqueueMissingPairs,
    processQueue,
    getDistance
};
