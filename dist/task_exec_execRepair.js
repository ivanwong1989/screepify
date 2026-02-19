// src/task/exec/execRepair.js
'use strict';

const STATUS = require('task_core_status');
const actionArbiter = require('task_core_actionArbiter');

module.exports = function execRepair(creep, intent, context = {}) {
  try {
    const target = intent && intent.targetId ? Game.getObjectById(intent.targetId) : null;
    const range = (intent && Number.isFinite(intent.range)) ? intent.range : 3;

    if (!target) return { status: STATUS.INVALID };
    if (typeof target.hits !== 'number' || typeof target.hitsMax !== 'number') return { status: STATUS.INVALID };
    if (target.hits >= target.hitsMax) return { status: STATUS.INVALID };
    if (!creep.store || creep.store.getUsedCapacity(RESOURCE_ENERGY) <= 0) return { status: STATUS.INVALID };

    if (creep._actionState && !actionArbiter.canUse(creep._actionState, actionArbiter.SLOTS.work)) {
      return { status: STATUS.RETRY, rc: ERR_BUSY };
    }

    if (creep._actionState) actionArbiter.claim(creep._actionState, actionArbiter.SLOTS.work);

    const rc = creep.repair(target);
    if (rc === OK) return { status: STATUS.OK };
    if (rc === ERR_NOT_IN_RANGE) {
      if (context.moveToTarget) context.moveToTarget(creep, target, range);
      return { status: STATUS.MOVING };
    }

    if (rc === ERR_BUSY || rc === ERR_TIRED) return { status: STATUS.RETRY, rc };
    if (rc === ERR_INVALID_TARGET || rc === ERR_NOT_ENOUGH_RESOURCES) return { status: STATUS.INVALID, rc };

    return { status: STATUS.ERROR, rc };
  } catch (e) {
    return { status: STATUS.ERROR, error: String(e && e.stack || e) };
  }
};
