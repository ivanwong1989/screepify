// @ts-check
'use strict';

/**
 * Task contract (DESIGN §9), stored in `creep.memory.t`. Types only + status codes.
 *
 * @typedef {'harvest'|'transfer'|'withdraw'|'pickup'|'upgrade'|'build'|'repair'
 *   |'dismantle'|'reserve'|'claim'|'move'|'drop'|'wait'|'lane'|'mlane'} Action
 *
 * @typedef {Object} Task
 * @property {Action} a    action
 * @property {string} [i]  target id
 * @property {string} [p]  packed target pos "x:y:room" (when there is no id)
 * @property {ResourceConstant} [r]  resource type (default energy)
 * @property {number} [n]  range (default per action)
 * @property {number} [q]  amount (withdraw/transfer cap), or the tick to wait until ('wait')
 *
 * Creep memory in v2:
 * @typedef {Object} CreepMemoryV2
 * @property {string} a    archetype (miner, hauler, worker, scout, ...)
 * @property {string} h    home room
 * @property {string} [b]  spawn binding key (slot key or mission id) — counts toward that contract
 * @property {string} [m]  assigned mission id
 * @property {Task} [t]    current task
 * @property {string} [s]  task state: 'init' | 'gathering' | 'working' | 'idle' (v1 taskState)
 */

/** Keep the task; the creep acted or moved toward its target this tick. */
const CONTINUE = 0;
/** The task finished with an action this tick; plan the next one (move only). */
const DONE = 1;
/** The task is finished or invalid and nothing happened; the next task may act now. */
const SKIP = 2;

module.exports = { CONTINUE, DONE, SKIP };
