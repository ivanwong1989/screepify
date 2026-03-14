/**
 * Purpose: shared per-room heap cache for reusable room queries.
 * Responsibilities: cache room query id lists with TTL and resolve live objects cheaply.
 * Persistent state touched: none.
 * Heap state: global.__heap.rooms[roomName].queryCache.
 */

function ensureHeapRoot() {
  if (!global.__heap || typeof global.__heap !== 'object') global.__heap = {};
  if (!global.__heap.rooms || typeof global.__heap.rooms !== 'object') global.__heap.rooms = {};
  return global.__heap;
}

function ensureRoomBucket(roomName) {
  const heap = ensureHeapRoot();
  if (!heap.rooms[roomName] || typeof heap.rooms[roomName] !== 'object') {
    heap.rooms[roomName] = {};
  }

  const roomBucket = heap.rooms[roomName];
  if (!roomBucket.queryCache || typeof roomBucket.queryCache !== 'object') {
    roomBucket.queryCache = {};
  }

  return roomBucket;
}

function normalizeIds(result) {
  if (!Array.isArray(result)) return [];

  const ids = [];
  for (let i = 0; i < result.length; i++) {
    const obj = result[i];
    if (obj && obj.id) ids.push(obj.id);
  }

  return ids;
}

function isStale(entry, ttl) {
  if (!entry || typeof entry !== 'object') return true;
  const age = Game.time - entry.tick;
  return age > ttl;
}

function getCachedIds(room, key, ttl, builder) {
  if (!room || !room.name) return [];
  const roomBucket = ensureRoomBucket(room.name);
  const cache = roomBucket.queryCache;
  const cacheKey = key;
  const cacheTtl = typeof ttl === 'number' ? ttl : 0;

  const entry = cache[cacheKey];
  if (!isStale(entry, cacheTtl)) {
    return Array.isArray(entry.ids) ? entry.ids : [];
  }

  const built = builder ? builder(room) : [];
  const ids = normalizeIds(built);

  cache[cacheKey] = {
    tick: Game.time,
    ids: ids,
  };

  return ids;
}

function getObjectsByIds(ids) {
  const out = [];
  if (!Array.isArray(ids)) return out;

  for (let i = 0; i < ids.length; i++) {
    const obj = Game.getObjectById(ids[i]);
    if (obj) out.push(obj);
  }

  return out;
}

function getCachedObjects(room, key, ttl, builder) {
  return getObjectsByIds(getCachedIds(room, key, ttl, builder));
}

function invalidateRoom(roomName) {
  if (!global.__heap || !global.__heap.rooms || !global.__heap.rooms[roomName]) return;
  if (global.__heap.rooms[roomName].queryCache) {
    global.__heap.rooms[roomName].queryCache = {};
  }
}

module.exports = {
  getCachedIds,
  getCachedObjects,
  getObjectsByIds,
  invalidateRoom,
};
