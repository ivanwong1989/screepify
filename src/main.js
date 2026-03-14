/**
 * Purpose: Screeps entrypoint for the new layered architecture.
 * Responsibilities: build a stable tick context and execute the kernel pipeline.
 * Persistent state touched: none directly.
 * Heap state: reads global.__heap after heap.init via kernel.
 */

const kernel = require('kernel_index');
const logger = require('utils_logger');
const roomUtils = require('utils_room');

module.exports.loop = function loop() {
  const ownedRooms = roomUtils.getOwnedRooms(Game);
  const context = {
    game: Game,
    memory: Memory,
    heap: global.__heap,
    time: Game.time,
    rooms: ownedRooms,
    creeps: Game.creeps,
  };

  try {
    kernel.run(context);
  } catch (error) {
    logger.error('fatal_tick_error', error && error.stack ? error.stack : error);
  }
};
