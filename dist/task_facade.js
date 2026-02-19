// src/task/facade.js
'use strict';

const runFreeActions = require('task_hooks_runFreeActions');
const execTransfer = require('task_exec_execTransfer');
const execWithdraw = require('task_exec_execWithdraw');
const execPickup = require('task_exec_execPickup');
const stuck = require('task_core_stuck');
const debug = require('task_core_debug');
const STATUS = require('task_core_status');

function settings() {
  return (Memory.settings && Memory.settings.taskRefactor) || {};
}

function runPrimaryFromTask(creep, task, context = {}) {
  const s = settings();
  if (!s.enabled) return null;
  if (!s.migrate) return null;
  if (!task) return null;

  let res = null;
  let invalidLimit = 3;

  // TRANSFER
  if (s.migrate.transfer && task.action === 'transfer') {
    res = execTransfer(creep, {
      type: 'transfer',
      targetId: task.targetId,
      resourceType: task.resourceType,
      range: task.range
    }, context);
  }

  // WITHDRAW
  else if (s.migrate.withdraw && task.action === 'withdraw') {
    res = execWithdraw(creep, {
      type: 'withdraw',
      targetId: task.targetId,
      resourceType: task.resourceType,
      amount: task.amount,
      range: task.range
    }, context);
  }

  // PICKUP
  else if (s.migrate.pickup && task.action === 'pickup') {
    res = execPickup(creep, {
      type: 'pickup',
      targetId: task.targetId,
      range: task.range
    }, context);
    invalidLimit = 2;
  }

  if (res) {
    debug.incGlobal('intents');
    const roomName = (creep.memory.room || (creep.room && creep.room.name)) || 'unknown';
    debug.incPerRoom(roomName, 'intents');
    debug.incPerRole(roomName, creep.memory.role, 'intents');

    stuck.onResult(creep, task, res, { invalidLimit });
    return res;
  }

  return null;
}

function runAfterPrimary(creep, context) {
  // “after primary” hook point (primary may be old role/task code for now)
  runFreeActions(creep, context);
}

module.exports = {
  runPrimaryFromTask,
  runAfterPrimary,
};
