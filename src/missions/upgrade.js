// @ts-check
'use strict';

const state = require('./shared/state');
const { gather } = require('./shared/gather');
const { vacate } = require('./shared/vacate');

/**
 * Controller upgrading (port of v1 mission.upgrade + mission.idleUpgrade + exec/upgrade).
 *
 * upgrade:controller  15 WORK while UPGRADING and policy GROW; trickle (spawn only
 *                     if downgrade is near) while STOCKPILING or policy CRITICAL /
 *                     STOCKPILE; 1 WORK in RECOVER / DEFENSIVE / SIEGE or while
 *                     anything is being built
 * idle:upgrade        catch-all for workers with nothing better (never spawns)
 */

const CRITICAL_DOWNGRADE_TICKS = 5000;

/**
 * @param {import('../contracts/mission').PlanContext} plan
 * @param {import('../contracts/mission').Mission[]} out
 */
function generate(plan, out) {
    const { rc, intel, state: rs, policy, census } = plan;
    const ctrl = intel.controller;
    if (!ctrl || !ctrl.my || rs.op === 'EMERGENCY') return;

    const critical = (ctrl.ticksToDowngrade || 0) < CRITICAL_DOWNGRADE_TICKS;
    const ps = policy ? policy.state : 'GROW';
    let prio = 50;
    let desiredWork = 15;
    let spawnAllowed = true;
    // Hold upgraders we have but spawn none (unless the controller is about to downgrade).
    let holdOnly = false;
    if (ps === 'CRITICAL' || ps === 'STOCKPILE' || rs.economy === 'STOCKPILING') {
        desiredWork = 1;
        prio = critical ? 100 : (ps === 'CRITICAL' ? 30 : ps === 'STOCKPILE' ? 5 : 10);
        spawnAllowed = critical;
        holdOnly = !critical;
    } else if (ps === 'RECOVER') {
        desiredWork = 1;
        prio = 20;
    } else if (ps === 'DEFENSIVE' || ps === 'SIEGE') {
        desiredWork = 1;
        prio = 25;
    }
    if (intel.sites.length > 0) {
        desiredWork = 1;
        prio = 20;
    }

    let work = desiredWork;
    let minCount = desiredWork > 0 ? 1 : 0;
    let maxCount = intel.availableControllerSpaces;
    if (holdOnly) {
        // Keep existing upgraders, spawn none.
        work = 0;
        minCount = Math.min(census('upgrade:controller').count, intel.availableControllerSpaces);
        maxCount = minCount;
    }

    out.push({
        id: 'upgrade:controller',
        type: 'upgrade',
        home: rc.name,
        room: rc.name,
        archetype: 'worker',
        demand: { work, minCreeps: minCount, maxCreeps: maxCount },
        spawn: spawnAllowed ? 'pool' : false,
        targetId: ctrl.id,
        pos: ctrl.pos,
        data: { sourceIds: intel.energySourceIds },
        priority: prio
    });
}

/**
 * @param {import('../contracts/mission').PlanContext} plan
 * @param {import('../contracts/mission').Mission[]} out
 */
function generateIdle(plan, out) {
    const { rc, intel, state: rs } = plan;
    const ctrl = intel.controller;
    if (!ctrl || !ctrl.my || rs.op === 'EMERGENCY') return;
    out.push({
        id: 'idle:upgrade',
        type: 'upgrade',
        home: rc.name,
        room: rc.name,
        archetype: 'worker',
        demand: { minCreeps: 0, maxCreeps: Math.min(12, Math.max(1, intel.availableControllerSpaces || 1)) },
        spawn: false,
        targetId: ctrl.id,
        pos: ctrl.pos,
        data: { sourceIds: intel.energySourceIds },
        priority: -100
    });
}

/** @type {import('../contracts/mission').MissionType['nextTask']} */
function nextTask(creep, m, rc) {
    state.update(creep);
    if (creep.memory.s === 'working') {
        const ctrl = creep.room.controller;
        if (ctrl) {
            const move = vacate(creep, 'upgrade', ctrl, 3);
            if (move) return move;
        }
        return { a: 'upgrade', i: m.targetId };
    }
    const data = /** @type {any} */ (m.data || {});
    return gather(creep, rc, { allowedIds: data.sourceIds || null });
}

module.exports = { type: 'upgrade', generate, generateIdle, nextTask };
