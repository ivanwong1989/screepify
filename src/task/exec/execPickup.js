// src/task/exec/execPickup.js
'use strict';

const STATUS = require('task_core_status');
const actionArbiter = require('task_core_actionArbiter');

module.exports = function execPickup(creep, intent, context = {}) {
  try {
    const target = intent && intent.targetId ? Game.getObjectById(intent.targetId) : null;
    const range = (intent && Number.isFinite(intent.range)) ? intent.range : 1;

    if (!target) return { status: STATUS.INVALID };
    // pickup target should be a Resource (dropped)
    if (typeof target.amount !== 'number') return { status: STATUS.INVALID };
    if (!creep.store || creep.store.getFreeCapacity() <= 0) return { status: STATUS.INVALID };

    if (creep._actionState) actionArbiter.claim(creep._actionState, actionArbiter.SLOTS.pickup);

    const rc = creep.pickup(target);
    if (rc === OK) return { status: STATUS.OK };
    if (rc === ERR_NOT_IN_RANGE) {
      if (context.moveToTarget) context.moveToTarget(creep, target, range);
      return { status: STATUS.MOVING };
    }

    if (rc === ERR_BUSY || rc === ERR_TIRED) return { status: STATUS.RETRY, rc };

    // resource disappeared or invalid => INVALID
    if (rc === ERR_INVALID_TARGET || rc === ERR_FULL) return { status: STATUS.INVALID, rc };

    return { status: STATUS.ERROR, rc };
  } catch (e) {
    return { status: STATUS.ERROR, error: String(e && e.stack || e) };
  }
};
