// @ts-check
'use strict';

const movement = require('../services/movement');
const traffic = require('../services/traffic');
const { unpack } = require('../services/pos');
const { CONTINUE, DONE, SKIP } = require('../contracts/task');

/**
 * Action executors (DESIGN §9): one per task action. Each moves into range,
 * performs the intent, and reports:
 *   CONTINUE  keep this task next tick
 *   DONE      acted this tick and the task is complete
 *   SKIP      complete or invalid without acting (the next task may act now)
 *
 * Work actions finish when the creep will run out of energy (or fill up, for
 * harvest) after this tick's intent, so the next task is planned without an
 * idle tick.
 */

/** @typedef {import('../contracts/task').Task} Task */
/** @typedef {(creep: Creep, task: Task) => number} Executor */

/** Actions that share the "work" intent pipeline. */
const WORK_PIPE = new Set(['harvest', 'build', 'repair', 'upgrade', 'dismantle']);
/** Actions that share the "carry" intent pipeline. */
const CARRY_PIPE = new Set(['transfer', 'withdraw', 'pickup', 'drop']);

/**
 * @param {Task} task
 * @returns {any}
 */
function targetOf(task) {
    if (task.i) return Game.getObjectById(/** @type {any} */ (task.i));
    if (task.p) return unpack(task.p);
    return null;
}

/**
 * Moves toward the target if out of range.
 * @param {Creep} creep
 * @param {any} target
 * @param {number} range
 * @returns {boolean} true if the creep is in range now
 */
function approach(creep, target, range) {
    const pos = target.pos || target;
    if (creep.pos.roomName === pos.roomName && creep.pos.inRangeTo(pos, range)) {
        traffic.working(creep, pos, range);
        return true;
    }
    movement.to(creep, pos, { range });
    return false;
}

/** @param {Task} t @param {number} d */
function rangeOf(t, d) {
    return Number.isFinite(t.n) ? /** @type {number} */ (t.n) : d;
}

/** @param {Creep} creep */
function work(creep) {
    return creep.getActiveBodyparts(WORK);
}

/** @type {Record<string, Executor>} */
const actions = {
    move(creep, t) {
        const target = targetOf(t);
        if (!target) return SKIP;
        const pos = target.pos || target;
        const range = rangeOf(t, 1);
        if (movement.arrived(creep.pos, pos, range)) return SKIP;
        movement.to(creep, pos, { range });
        return CONTINUE;
    },

    harvest(creep, t) {
        const src = targetOf(t);
        if (!src) return SKIP;
        if (!approach(creep, src, 1)) return CONTINUE;
        traffic.pin(creep);
        const r = creep.harvest(src);
        if (r === OK) {
            const cap = creep.store.getCapacity();
            if (cap > 0 && creep.store.getFreeCapacity() <= work(creep) * HARVEST_POWER) return DONE;
            return CONTINUE;
        }
        if (r === ERR_NOT_ENOUGH_RESOURCES || r === ERR_TIRED) return CONTINUE; // wait for regen
        return SKIP;
    },

    transfer(creep, t) {
        const target = targetOf(t);
        const rt = t.r || RESOURCE_ENERGY;
        if (!target || (creep.store[rt] || 0) <= 0) return SKIP;
        if (target.store && target.store.getFreeCapacity(rt) === 0) return SKIP;
        if (!approach(creep, target, rangeOf(t, 1))) return CONTINUE;
        const r = t.q ? creep.transfer(target, rt, Math.min(t.q, creep.store[rt])) : creep.transfer(target, rt);
        return r === OK ? DONE : SKIP;
    },

    withdraw(creep, t) {
        const src = targetOf(t);
        const rt = t.r || RESOURCE_ENERGY;
        if (!src || !src.store || (src.store[rt] || 0) <= 0) return SKIP;
        if (creep.store.getFreeCapacity(rt) <= 0) return SKIP;
        if (!approach(creep, src, 1)) return CONTINUE;
        const r = t.q
            ? creep.withdraw(src, rt, Math.min(t.q, src.store[rt], creep.store.getFreeCapacity(rt)))
            : creep.withdraw(src, rt);
        return r === OK ? DONE : SKIP;
    },

    pickup(creep, t) {
        const res = targetOf(t);
        if (!res || creep.store.getFreeCapacity() <= 0) return SKIP;
        if (!approach(creep, res, 1)) return CONTINUE;
        return creep.pickup(res) === OK ? DONE : SKIP;
    },

    upgrade(creep, t) {
        const ctrl = targetOf(t);
        const energy = creep.store[RESOURCE_ENERGY] || 0;
        if (!ctrl || energy <= 0) return SKIP;
        if (!approach(creep, ctrl, rangeOf(t, 3))) return CONTINUE;
        const r = creep.upgradeController(ctrl);
        if (r !== OK) return SKIP;
        return energy <= work(creep) * UPGRADE_CONTROLLER_POWER ? DONE : CONTINUE;
    },

    build(creep, t) {
        const site = targetOf(t);
        const energy = creep.store[RESOURCE_ENERGY] || 0;
        if (!site || energy <= 0) return SKIP;
        if (!approach(creep, site, rangeOf(t, 3))) return CONTINUE;
        const r = creep.build(site);
        if (r !== OK) return SKIP;
        const w = work(creep);
        const done = energy <= w * BUILD_POWER || site.progress + w * BUILD_POWER >= site.progressTotal;
        return done ? DONE : CONTINUE;
    },

    repair(creep, t) {
        const target = targetOf(t);
        const energy = creep.store[RESOURCE_ENERGY] || 0;
        if (!target || energy <= 0 || target.hits >= target.hitsMax) return SKIP;
        if (!approach(creep, target, rangeOf(t, 3))) return CONTINUE;
        const r = creep.repair(target);
        if (r !== OK) return SKIP;
        const w = work(creep);
        const done = energy <= w || target.hits + w * REPAIR_POWER >= target.hitsMax;
        return done ? DONE : CONTINUE;
    },

    dismantle(creep, t) {
        const target = targetOf(t);
        if (!target) return SKIP;
        if (!approach(creep, target, 1)) return CONTINUE;
        return creep.dismantle(target) === OK ? CONTINUE : SKIP;
    },

    reserve(creep, t) {
        const ctrl = targetOf(t);
        if (!ctrl) return SKIP;
        if (!approach(creep, ctrl, 1)) return CONTINUE;
        return creep.reserveController(ctrl) === OK ? CONTINUE : SKIP;
    },

    claim(creep, t) {
        const ctrl = targetOf(t);
        if (!ctrl) return SKIP;
        if (!approach(creep, ctrl, 1)) return CONTINUE;
        return creep.claimController(ctrl) === OK ? DONE : SKIP;
    },

    drop(creep, t) {
        const rt = t.r || RESOURCE_ENERGY;
        if ((creep.store[rt] || 0) <= 0) return SKIP;
        return creep.drop(rt) === OK ? DONE : SKIP;
    },

    wait(creep, t) {
        return Game.time >= (t.q || 0) ? SKIP : CONTINUE;
    },

    // The core lane hauler decides every tick itself (missions/coreLane).
    lane(creep) {
        return require('../missions/coreLane').run(creep);
    },

    // Mining lane haulers too (missions/miningLane).
    mlane(creep) {
        return require('../missions/miningLane').run(creep);
    },

    // And the lab hauler, through committed logistics jobs (missions/labHaul).
    haul(creep) {
        return require('../missions/labHaul').run(creep);
    }
};

/**
 * @param {Creep} creep
 * @param {Task} task
 * @returns {number}
 */
function run(creep, task) {
    const fn = actions[task.a];
    return fn ? fn(creep, task) : SKIP;
}

/**
 * After a task finished with an action, use the rest of the tick for the next
 * one: a carry action can still happen after a work action (separate intent
 * pipelines); otherwise just start walking toward the next target.
 * @param {Creep} creep
 * @param {string} prevAction
 * @param {Task} next
 * @returns {number} the next task's status if it ran, else CONTINUE
 */
function followUp(creep, prevAction, next) {
    if (WORK_PIPE.has(prevAction) && CARRY_PIPE.has(next.a)) return run(creep, next);
    if (next.a === 'wait' || next.a === 'drop') return CONTINUE;
    const target = targetOf(next);
    if (!target) return CONTINUE;
    const pos = target.pos || target;
    const range = rangeOf(next, next.a === 'upgrade' || next.a === 'build' || next.a === 'repair' ? 3 : 1);
    if (!movement.arrived(creep.pos, pos, range)) movement.to(creep, pos, { range });
    return CONTINUE;
}

module.exports = { run, followUp, actions, WORK_PIPE, CARRY_PIPE };
