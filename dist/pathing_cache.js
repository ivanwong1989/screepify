/**
 * Purpose: heap-backed path and cost matrix cache helpers.
 * Responsibilities: read/write path cache and invalidate room-derived entries.
 * Persistent state touched: none.
 * Heap state: global.__heap.pathCache and global.__heap.rooms[*].costMatrix.
 */

function getHeap() {
  if (!global.__heap) global.__heap = {};
  if (!global.__heap.pathCache) global.__heap.pathCache = {};
  if (!global.__heap.rooms) global.__heap.rooms = {};
  return global.__heap;
}

function getCachedPath(key) {
  return getHeap().pathCache[key];
}

function setCachedPath(key, value) {
  getHeap().pathCache[key] = value;
}

function getRoomCostMatrix(roomName) {
  const heap = getHeap();
  if (!heap.rooms[roomName]) heap.rooms[roomName] = {};
  return heap.rooms[roomName].costMatrix || null;
}

function invalidateRoom(roomName) {
  const heap = getHeap();
  if (heap.rooms[roomName]) {
    delete heap.rooms[roomName].costMatrix;
  }
}

module.exports = {
  getCachedPath,
  setCachedPath,
  getRoomCostMatrix,
  invalidateRoom,
};
