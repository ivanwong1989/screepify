// src/task/exec/execWithdraw.js
'use strict';

const STATUS = require('task_core_status');
const actionArbiter = require('task_core_actionArbiter');

module.exports = function execWithdraw(creep, intent, context = {}) {
  try {
    const target = intent && intent.targetId ? Game.getObjectById(intent.targetId) : null;
    const resourceType = intent && intent.resourceType;
    const amount = intent && Number.isFinite(intent.amount) ? intent.amount : undefined;
    const range = (intent && Number.isFinite(intent.range)) ? intent.range : 1;

    if (!target || !resourceType) return { status: STATUS.INVALID };
    if (!creep.store || creep.store.getFreeCapacity(resourceType) <= 0) return { status: STATUS.INVALID };

    if (creep._actionState) actionArbiter.claim(creep._actionState, actionArbiter.SLOTS.withdraw);

    const rc = creep.withdraw(target, resourceType, amount);
    if (rc === OK) return { status: STATUS.OK };
    if (rc === ERR_NOT_IN_RANGE) {
      if (context.moveToTarget) context.moveToTarget(creep, target, range);
      return { status: STATUS.MOVING };
    }

    // transient-ish / not fatal => RETRY (do not clear task here)
    if (rc === ERR_BUSY || rc === ERR_TIRED) return { status: STATUS.RETRY, rc };

    // common “planner mismatch” signals: treat as INVALID so old fallback / replanner can handle
    if (rc === ERR_NOT_ENOUGH_RESOURCES || rc === ERR_FULL || rc === ERR_INVALID_TARGET) {
      return { status: STATUS.INVALID, rc };
    }

    return { status: STATUS.ERROR, rc };
  } catch (e) {
    return { status: STATUS.ERROR, error: String(e && e.stack || e) };
  }
};
