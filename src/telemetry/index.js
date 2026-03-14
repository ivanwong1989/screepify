/**
 * Purpose: record lightweight telemetry for CPU and economy.
 * Responsibilities: keep compact rolling stats in Memory.telemetry.
 * Persistent state touched: Memory.telemetry.
 * Heap state: none.
 */

function run(context) {
  if (!Memory.telemetry || typeof Memory.telemetry !== 'object') Memory.telemetry = {};

  Memory.telemetry.lastTick = {
    time: Game.time,
    cpuUsed: Math.round(Game.cpu.getUsed() * 100) / 100,
    gclLevel: Game.gcl ? Game.gcl.level : 0,
    roomCount: context && Array.isArray(context.rooms) ? context.rooms.length : 0,
    serviceCount: Memory.services ? Object.keys(Memory.services).length : 0,
    missionCount: Memory.missions ? Object.keys(Memory.missions).length : 0,
  };
}

module.exports = { run };
