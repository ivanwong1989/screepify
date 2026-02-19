'use strict';

function ensureStatsRoot() {
  Memory.stats = Memory.stats || {};
  Memory.stats.taskRefactor = Memory.stats.taskRefactor || {};
  Memory.stats.taskRefactor._tick = Game.time; // last tick written
  Memory.stats.taskRefactor.global = Memory.stats.taskRefactor.global || {
    tick: Game.time,
    intents: 0,
    fallbacks: 0,
    invalid: 0,
    errors: 0,
  };
}

function beginTick() {
  // Reset only once per tick
  Memory.stats = Memory.stats || {};
  Memory.stats.taskRefactor = Memory.stats.taskRefactor || {};
  if (Memory.stats.taskRefactor._tick !== Game.time) {
    Memory.stats.taskRefactor._tick = Game.time;
    Memory.stats.taskRefactor.global = {
      tick: Game.time,
      intents: 0,
      fallbacks: 0,
      invalid: 0,
      errors: 0,
    };
  }
}

function incGlobal(key, amount = 1) {
  beginTick();
  const g = Memory.stats.taskRefactor.global;
  g[key] = (g[key] || 0) + amount;
}

function incPerRoom(roomName, key, amount = 1) {
  beginTick();
  const root = Memory.stats.taskRefactor;
  root.rooms = root.rooms || {};
  root.rooms[roomName] = root.rooms[roomName] || { intents:0, fallbacks:0, invalid:0, errors:0 };
  root.rooms[roomName][key] = (root.rooms[roomName][key] || 0) + amount;
}

function incPerRole(roomName, role, key, amount = 1) {
  beginTick();
  const root = Memory.stats.taskRefactor;
  root.roles = root.roles || {};
  const bucket = `${roomName}:${role || 'unknown'}`;
  root.roles[bucket] = root.roles[bucket] || { intents:0, fallbacks:0, invalid:0, errors:0 };
  root.roles[bucket][key] = (root.roles[bucket][key] || 0) + amount;
}

module.exports = { ensureStatsRoot, beginTick, incGlobal, incPerRoom, incPerRole };
