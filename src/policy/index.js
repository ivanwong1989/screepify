/**
 * Purpose: derive room operating policies each tick.
 * Responsibilities: iterate owned rooms and persist computed room policy.
 * Persistent state touched: Memory.rooms[roomName].policy.
 * Heap state: none.
 */

const state = require('state_index');
const roomPolicy = require('policy_roomPolicy');

function run(context) {
  const rooms = context && Array.isArray(context.rooms) ? context.rooms : [];
  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i];
    const roomState = state.ensureRoomState(room.name);
    roomState.policy = roomPolicy.build(room, context);
  }
}

module.exports = { run };
