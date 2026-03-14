/**
 * Purpose: define persistent memory schema constants and helpers.
 * Responsibilities: ensure bot root and per-room memory shape exists.
 * Persistent state touched: Memory.bot, Memory.empire, Memory.rooms, Memory.services, Memory.missions, Memory.intel, Memory.telemetry.
 * Heap state: none.
 */

const MEMORY_VERSION = 1;

function ensureRoot(memory) {
  const root = memory || Memory;

  if (!root.bot || typeof root.bot !== 'object') {
    root.bot = { version: MEMORY_VERSION };
  }
  if (root.bot.version !== MEMORY_VERSION) {
    root.bot.version = MEMORY_VERSION;
  }

  if (!root.empire || typeof root.empire !== 'object') root.empire = {};
  if (!root.rooms || typeof root.rooms !== 'object') root.rooms = {};
  if (!root.services || typeof root.services !== 'object') root.services = {};
  if (!root.missions || typeof root.missions !== 'object') root.missions = {};
  if (!root.intel || typeof root.intel !== 'object') root.intel = {};
  if (!root.telemetry || typeof root.telemetry !== 'object') root.telemetry = {};

  return root;
}

function ensureRoomMemory(roomName, memory) {
  const root = ensureRoot(memory);

  if (!root.rooms[roomName] || typeof root.rooms[roomName] !== 'object') {
    root.rooms[roomName] = {};
  }

  const roomMemory = root.rooms[roomName];
  if (!roomMemory.policy || typeof roomMemory.policy !== 'object') roomMemory.policy = {};
  if (!Array.isArray(roomMemory.spawnQueue)) roomMemory.spawnQueue = [];
  if (!roomMemory.runtimeMeta || typeof roomMemory.runtimeMeta !== 'object') roomMemory.runtimeMeta = {};

  return roomMemory;
}

module.exports = {
  MEMORY_VERSION,
  ensureRoot,
  ensureRoomMemory,
};
