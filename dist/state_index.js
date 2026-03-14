/**
 * Purpose: memory initialization and room state bootstrap.
 * Responsibilities: initialize root schema, per-owned-room schema, and lightweight memory GC.
 * Persistent state touched: Memory root keys, Memory.rooms[roomName], Memory.creeps, Memory.missions[*].assigned.
 * Heap state: none.
 */

const memorySchema = require('state_memory');

const GC_INTERVAL = 5;
const MAX_SPAWN_QUEUE_LENGTH = 50;

function ensureRoomState(roomName) {
  return memorySchema.ensureRoomMemory(roomName, Memory);
}

function garbageCollectCreeps(context) {
  if (!Memory.creeps || typeof Memory.creeps !== 'object') return;

  const liveCreeps = context && context.creeps ? context.creeps : Game.creeps;
  for (const creepName in Memory.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Memory.creeps, creepName)) continue;
    if (!liveCreeps[creepName]) {
      delete Memory.creeps[creepName];
    }
  }
}

function garbageCollectMissionAssignments(context) {
  if (!Memory.missions || typeof Memory.missions !== 'object') return;

  const liveCreeps = context && context.creeps ? context.creeps : Game.creeps;
  for (const missionId in Memory.missions) {
    if (!Object.prototype.hasOwnProperty.call(Memory.missions, missionId)) continue;

    const mission = Memory.missions[missionId];
    if (!mission || !Array.isArray(mission.assigned)) continue;

    mission.assigned = mission.assigned.filter(function filterAssigned(name) {
      return !!liveCreeps[name];
    });
  }
}

function sanitizeRoomSpawnQueue(roomMemory) {
  if (!Array.isArray(roomMemory.spawnQueue)) {
    roomMemory.spawnQueue = [];
    return;
  }

  const now = Game.time;
  roomMemory.spawnQueue = roomMemory.spawnQueue.filter(function filterEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.expiresAt === 'number' && entry.expiresAt < now) return false;
    if (typeof entry.createdAt === 'number' && now - entry.createdAt > 1500) return false;
    return true;
  });

  if (roomMemory.spawnQueue.length > MAX_SPAWN_QUEUE_LENGTH) {
    roomMemory.spawnQueue = roomMemory.spawnQueue.slice(0, MAX_SPAWN_QUEUE_LENGTH);
  }
}

function garbageCollectRooms(context) {
  const rooms = context && Array.isArray(context.rooms) ? context.rooms : [];
  for (let i = 0; i < rooms.length; i++) {
    const roomState = ensureRoomState(rooms[i].name);
    sanitizeRoomSpawnQueue(roomState);
  }
}

function shouldRunGc() {
  if (!Memory.bot || typeof Memory.bot !== 'object') return true;
  const lastGcTick = Memory.bot.lastGcTick;
  if (typeof lastGcTick !== 'number') return true;
  return Game.time - lastGcTick >= GC_INTERVAL;
}

function runGc(context) {
  if (!shouldRunGc()) return;

  garbageCollectCreeps(context);
  garbageCollectMissionAssignments(context);
  garbageCollectRooms(context);

  Memory.bot.lastGcTick = Game.time;
}

function init(context) {
  memorySchema.ensureRoot(context && context.memory ? context.memory : Memory);

  const rooms = context && Array.isArray(context.rooms) ? context.rooms : [];
  for (let i = 0; i < rooms.length; i++) {
    ensureRoomState(rooms[i].name);
  }

  runGc(context);
}

module.exports = {
  init,
  ensureRoomState,
};
