/**
 * Purpose: central pathing helpers backed by heap cache.
 * Responsibilities: basic path retrieval and path serialization helpers.
 * Persistent state touched: none.
 * Heap state: path cache entries under global.__heap.pathCache.
 */

const cache = require('pathing_cache');

function makePathKey(fromPos, toPos, range) {
  return [
    fromPos.roomName,
    fromPos.x,
    fromPos.y,
    toPos.roomName,
    toPos.x,
    toPos.y,
    range || 1,
  ].join('|');
}

function getPath(fromPos, toPos, options) {
  const opts = options || {};
  const range = opts.range || 1;
  const key = makePathKey(fromPos, toPos, range);
  const cached = cache.getCachedPath(key);
  if (cached) return cached;

  const result = PathFinder.search(fromPos, { pos: toPos, range: range }, opts);
  cache.setCachedPath(key, result.path);
  return result.path;
}

function getRoute(fromRoomName, toRoomName) {
  if (fromRoomName === toRoomName) return [fromRoomName];
  const route = Game.map.findRoute(fromRoomName, toRoomName);
  if (route === ERR_NO_PATH || !Array.isArray(route)) return [];

  const out = [];
  for (let i = 0; i < route.length; i++) {
    out.push(route[i].room);
  }
  return out;
}

function serializePath(path) {
  return Room.serializePath(path || []);
}

function deserializePath(serialized) {
  if (!serialized) return [];
  return Room.deserializePath(serialized);
}

module.exports = {
  getPath,
  getRoute,
  serializePath,
  deserializePath,
};
