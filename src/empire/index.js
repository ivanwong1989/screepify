/**
 * Purpose: set empire-level directives and room designations.
 * Responsibilities: write coarse strategy only, no creep micromanagement.
 * Persistent state touched: Memory.empire and Memory.empire.rooms.
 * Heap state: none.
 */

function run(context) {
  if (!Memory.empire || typeof Memory.empire !== 'object') {
    Memory.empire = {};
  }

  if (!Memory.empire.directives || typeof Memory.empire.directives !== 'object') {
    Memory.empire.directives = {
      econFocus: 'stabilize',
      expansionEnabled: false,
    };
  }

  if (!Memory.empire.rooms || typeof Memory.empire.rooms !== 'object') {
    Memory.empire.rooms = {};
  }

  const rooms = context && Array.isArray(context.rooms) ? context.rooms : [];
  for (let i = 0; i < rooms.length; i++) {
    const roomName = rooms[i].name;
    const roomRecord = Memory.empire.rooms[roomName] || {};
    roomRecord.designation = roomRecord.designation || 'core';
    if (!Array.isArray(roomRecord.sponsorRemotes)) roomRecord.sponsorRemotes = [];
    Memory.empire.rooms[roomName] = roomRecord;
  }
}

module.exports = { run };
