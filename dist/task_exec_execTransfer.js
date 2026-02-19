// src/task/exec/execTransfer.js
'use strict';

const STATUS = require('task_core_status');
const actionArbiter = require('task_core_actionArbiter');

module.exports = function execTransfer(creep, intent, context = {}) {
  try {
    const target = intent && intent.targetId ? Game.getObjectById(intent.targetId) : null;
    const resourceType = intent && intent.resourceType;
    const range = (intent && Number.isFinite(intent.range)) ? intent.range : 1;

    if (!target || !resourceType) return { status: STATUS.INVALID };

    // must have something to transfer
    if (!creep.store || creep.store.getUsedCapacity(resourceType) <= 0) {
      return { status: STATUS.INVALID };
    }

    if (creep._actionState) actionArbiter.claim(creep._actionState, actionArbiter.SLOTS.transfer);

    const rc = creep.transfer(target, resourceType);
    if (rc === OK) return { status: STATUS.OK };
    if (rc === ERR_NOT_IN_RANGE) {
      if (context.moveToTarget) context.moveToTarget(creep, target, range);
      return { status: STATUS.MOVING };
    }

    // transient / target full / busy etc => RETRY (do not clear task here)
    if (rc === ERR_FULL || rc === ERR_BUSY || rc === ERR_TIRED) return { status: STATUS.RETRY, rc };

    return { status: STATUS.ERROR, rc };
  } catch (e) {
    return { status: STATUS.ERROR, error: String(e && e.stack || e) };
  }
};
