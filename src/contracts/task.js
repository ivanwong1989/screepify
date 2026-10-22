// @ts-check
'use strict';

/**
 * Task contract (DESIGN §9), stored in `creep.memory.t`. Types only — phase 1.
 *
 * @typedef {'harvest'|'transfer'|'withdraw'|'pickup'|'upgrade'|'build'|'repair'
 *   |'dismantle'|'reserve'|'claim'|'move'|'drop'} Action
 *
 * @typedef {Object} Task
 * @property {Action} a    action
 * @property {string} [i]  target id
 * @property {string} [p]  packed target pos (when there is no id)
 * @property {ResourceConstant} [r]  resource type (default energy)
 * @property {number} [n]  range (default per action)
 *
 * @typedef {0|1|2} ActionStatus   CONTINUE | DONE | FAIL
 *
 * @typedef {Object} CreepMemoryV2
 * @property {string} [m]  mission id
 * @property {Task} [t]    current task
 * @property {string} [h]  home room
 */

const CONTINUE = 0;
const DONE = 1;
const FAIL = 2;

module.exports = { CONTINUE, DONE, FAIL };
