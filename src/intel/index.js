/**
 * Purpose: collect lightweight room intel for visible owned rooms.
 * Responsibilities: update hostiles, sources, ownership and timestamps.
 * Persistent state touched: Memory.intel.rooms[roomName].
 * Heap state: none.
 */

function run(context) {
  if (!Memory.intel || typeof Memory.intel !== 'object') Memory.intel = {};
  if (!Memory.intel.rooms || typeof Memory.intel.rooms !== 'object') Memory.intel.rooms = {};

  const rooms = context && Array.isArray(context.rooms) ? context.rooms : [];
  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i];
    const hostiles = room.find(FIND_HOSTILE_CREEPS).length;
    const sources = room.find(FIND_SOURCES);

    const sourceIds = [];
    for (let s = 0; s < sources.length; s++) {
      sourceIds.push(sources[s].id);
    }

    Memory.intel.rooms[room.name] = {
      lastSeen: Game.time,
      hostiles: hostiles,
      sourceIds: sourceIds,
      owner: room.controller && room.controller.owner ? room.controller.owner.username : null,
    };
  }
}

module.exports = { run };
