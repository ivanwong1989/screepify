/**
 * Purpose: mission subsystem entrypoint.
 * Responsibilities: run mission modules for each owned room.
 * Persistent state touched: Memory.missions.
 * Heap state: global.__heap.missions may hold runtime mission views.
 */

const roomMissions = require('missions_roomMissions');

function run(context) {
  const rooms = context && Array.isArray(context.rooms) ? context.rooms : [];
  for (let i = 0; i < rooms.length; i++) {
    roomMissions.runRoom(rooms[i], context);
  }
}

module.exports = { run };
