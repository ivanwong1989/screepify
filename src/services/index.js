/**
 * Purpose: service subsystem entrypoint.
 * Responsibilities: run service modules for each owned room.
 * Persistent state touched: Memory.services.
 * Heap state: global.__heap.services may be used by future service caches.
 */

const roomServices = require('services_roomServices');

function run(context) {
  const rooms = context && Array.isArray(context.rooms) ? context.rooms : [];
  for (let i = 0; i < rooms.length; i++) {
    roomServices.runRoom(rooms[i], context);
  }
}

module.exports = { run };
