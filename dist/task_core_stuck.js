// c:\Users\ivanw\Projects\Screeps\screepify\src\task\core\stuck.js
'use strict';

const STATUS = require('task_core_status');
const debug = require('task_core_debug');

const DEFAULT_INVALID_LIMIT = 3; // safe start (3 consecutive INVALID ticks)

function taskSig(task) {
  if (!task) return '';
  const t = task.action || '';
  const id = task.targetId || task.targetName || '';
  const pos = task.targetPos ? `${task.targetPos.roomName}:${task.targetPos.x},${task.targetPos.y}` : '';
  const res = task.resourceType || '';
  const amt = task.amount || '';
  return `||||`;
}

function reset(mem) {
  if (!mem) return;
  delete mem._taskInvalid;
}

function onResult(creep, task, result, context = {}) {
  if (!creep || !creep.memory || !task || !result) return;

  const invalidLimit = (context.invalidLimit && Number.isFinite(context.invalidLimit))
    ? context.invalidLimit
    : DEFAULT_INVALID_LIMIT;

  // Only track INVALID; anything else resets the streak
  if (result.status !== STATUS.INVALID) {
    reset(creep.memory);
    return;
  }

  const sig = taskSig(task);
  const bucket = creep.memory._taskInvalid || { sig: null, count: 0, last: 0 };

  if (bucket.sig !== sig) {
    bucket.sig = sig;
    bucket.count = 1;
  } else {
    // ensure consecutive-ish; if huge gaps, still ok but keep simple
    bucket.count = (bucket.count || 0) + 1;
  }
  bucket.last = Game.time;
  creep.memory._taskInvalid = bucket;

  // Debug stats (optional but helpful)
  const roomName = (creep.memory.room || (creep.room && creep.room.name)) || 'unknown';
  debug.incGlobal('invalid');
  debug.incPerRoom(roomName, 'invalid');
  debug.incPerRole(roomName, creep.memory.role, 'invalid');

  if (bucket.count >= invalidLimit) {
    // Clear ONLY the task to force replanning next tick
    delete creep.memory.task;
    reset(creep.memory);

    // Optional: mark for visibility
    creep.memory._taskReplanTick = Game.time;
  }
}

module.exports = { onResult };
