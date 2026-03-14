/**
 * Purpose: initialize rebuildable heap containers.
 * Responsibilities: ensure runtime caches exist and room cache buckets are available.
 * Persistent state touched: none.
 * Heap state: global.__heap root and child caches.
 */

function init(context) {
  if (!global.__heap || typeof global.__heap !== 'object') {
    global.__heap = {};
  }

  const heap = global.__heap;
  if (!heap.rooms || typeof heap.rooms !== 'object') heap.rooms = {};
  if (!heap.pathCache || typeof heap.pathCache !== 'object') heap.pathCache = {};
  if (!heap.structureIndex || typeof heap.structureIndex !== 'object') heap.structureIndex = {};
  if (!heap.services || typeof heap.services !== 'object') heap.services = {};
  if (!heap.missions || typeof heap.missions !== 'object') heap.missions = {};

  const rooms = context && Array.isArray(context.rooms) ? context.rooms : [];
  for (let i = 0; i < rooms.length; i++) {
    const roomName = rooms[i].name;
    if (!heap.rooms[roomName] || typeof heap.rooms[roomName] !== 'object') {
      heap.rooms[roomName] = {};
    }

    const roomHeap = heap.rooms[roomName];
    if (!roomHeap.queryCache || typeof roomHeap.queryCache !== 'object') {
      roomHeap.queryCache = {};
    }
  }
}

module.exports = { init };
