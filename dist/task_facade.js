// src/task/facade.js
'use strict';

const runFreeActions = require('task_hooks_runFreeActions');
const execTransfer = require('task_exec_execTransfer');
const execWithdraw = require('task_exec_execWithdraw');
const execPickup = require('task_exec_execPickup');
const execBuild = require('task_exec_execBuild');
const execRepair = require('task_exec_execRepair');
const execUpgrade = require('task_exec_execUpgrade');
const resolveBuildTarget = require('task_resolve_resolveBuildTarget');
const resolveRepairTarget = require('task_resolve_resolveRepairTarget');
const resolveUpgradeTarget = require('task_resolve_resolveUpgradeTarget');
const stuck = require('task_core_stuck');
const debug = require('task_core_debug');
const STATUS = require('task_core_status');

function settings() {
  return (Memory.settings && Memory.settings.taskRefactor) || {};
}

function getRoomIntel(room) {
  if (!room) return null;
  if (global.getRoomCache) {
    const cache = global.getRoomCache(room) || {};
    return {
      constructionSites: cache.constructionSites || [],
      structures: cache.structuresByType || {},
      hostiles: cache.hostiles || [],
      controller: room.controller
    };
  }

  const structures = room.find(FIND_STRUCTURES).reduce((acc, s) => {
    acc[s.structureType] = acc[s.structureType] || [];
    acc[s.structureType].push(s);
    return acc;
  }, {});

  return {
    constructionSites: room.find(FIND_CONSTRUCTION_SITES),
    structures,
    hostiles: room.find(FIND_HOSTILE_CREEPS),
    controller: room.controller
  };
}

function ensureResolvedTargetId(creep, task, context) {
  if (!creep || !task) return null;
  const targetId = task.targetId;
  if (targetId && Game.getObjectById(targetId)) return targetId;

  const room = creep.room;
  const intel = getRoomIntel(room);
  if (!intel) return null;

  if (task.action === 'build') {
    const res = resolveBuildTarget(room, intel);
    return res && res.targetId ? res.targetId : null;
  }

  if (task.action === 'repair') {
    const res = resolveRepairTarget(room, intel, context);
    if (!res) return null;
    if (Array.isArray(res.selectedTargets) && res.selectedTargets.length > 0) return res.selectedTargets[0].id;
    if (Array.isArray(res.selectedForts) && res.selectedForts.length > 0) return res.selectedForts[0].id;
    return null;
  }

  if (task.action === 'upgrade') {
    return resolveUpgradeTarget(room, intel);
  }

  return null;
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

  // BUILD
  else if (s.migrate.build && task.action === 'build') {
    const resolvedId = ensureResolvedTargetId(creep, task, context);
    if (!resolvedId) return null;
    if (task.targetId !== resolvedId && creep.memory && creep.memory.task) {
      creep.memory.task.targetId = resolvedId;
    }
    res = execBuild(creep, {
      type: 'build',
      targetId: resolvedId,
      range: task.range
    }, context);
  }

  // REPAIR
  else if (s.migrate.repair && task.action === 'repair') {
    const resolvedId = ensureResolvedTargetId(creep, task, context);
    if (!resolvedId) return null;
    if (task.targetId !== resolvedId && creep.memory && creep.memory.task) {
      creep.memory.task.targetId = resolvedId;
    }
    res = execRepair(creep, {
      type: 'repair',
      targetId: resolvedId,
      range: task.range
    }, context);
  }

  // UPGRADE
  else if (s.migrate.upgrade && task.action === 'upgrade') {
    const resolvedId = ensureResolvedTargetId(creep, task, context);
    if (!resolvedId) return null;
    if (task.targetId !== resolvedId && creep.memory && creep.memory.task) {
      creep.memory.task.targetId = resolvedId;
    }
    res = execUpgrade(creep, {
      type: 'upgrade',
      targetId: resolvedId,
      range: task.range
    }, context);
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
