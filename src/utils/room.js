/**
 * Purpose: room helper utilities for ownership and energy state.
 * Responsibilities: resolve owned rooms once and expose simple room signals.
 * Persistent state touched: none.
 * Heap state: none.
 */

function isOwnedRoom(room) {
  return !!(room && room.controller && room.controller.my);
}

function getOwnedRooms(game) {
  const src = game && game.rooms ? game.rooms : Game.rooms;
  const rooms = [];
  for (const roomName in src) {
    if (!Object.prototype.hasOwnProperty.call(src, roomName)) continue;
    const room = src[roomName];
    if (isOwnedRoom(room)) rooms.push(room);
  }
  return rooms;
}

function getEnergyState(room) {
  return {
    available: room ? room.energyAvailable : 0,
    capacity: room ? room.energyCapacityAvailable : 0,
  };
}

module.exports = {
  getOwnedRooms,
  isOwnedRoom,
  getEnergyState,
};
