// @ts-check
'use strict';

const scanner = require('../services/repairScan');
const policyRules = require('../services/policyRules');
const state = require('./shared/state');
const { gather } = require('./shared/gather');
const { vacate } = require('./shared/vacate');

/**
 * Fortify (port of v1 mission.fortify, dev_make_missions_missions).
 *
 * fortify:<room>  one mission per room. It always points at the weakest wall or
 *                 rampart below the RCL target (services/repairScan), so its
 *                 worker moves on as walls come up. One worker (12 WORK), two
 *                 while hostiles are in the room.
 *
 * - When: services/policyRules.fortifyMode (P1). No economy-state gate (v1).
 * - Backlog gate: a new fortifier is only spawned when the total missing hits
 *   are worth at least max(50k, 150 ticks of a full-size worker). Once one is
 *   working, it keeps going until the queue is empty.
 * - Critical walls (< 5k hits) stay with the repair mission.
 */

const DESIRED_WORK = 12;
const WORKER_SET_COST = 200;
const BACKLOG_TICKS = 150;
const BACKLOG_FLOOR = 50000;

/**
 * Hits to raise a wall/rampart to.
 * @param {Room} room
 * @param {any} s
 */
function targetHits(room, s) {
    const target = scanner.fortifyPolicy(room).target;
    return target > 0 ? Math.min(target, s.hitsMax) : 0;
}

/**
 * Minimum total missing hits before spawning a fortifier.
 * @param {number} capacity  room energy capacity
 */
function minBacklog(capacity) {
    const work = Math.max(1, Math.min(DESIRED_WORK, Math.floor(capacity / WORKER_SET_COST)));
    return Math.max(BACKLOG_FLOOR, work * REPAIR_POWER * BACKLOG_TICKS);
}

/**
 * Walls/ramparts below target, weakest first.
 * @param {Room} room
 * @returns {{list: any[], deficit: number}}
 */
function queue(room) {
    const list = [];
    let deficit = 0;
    for (const id of scanner.get(room.name).fortifyIds) {
        const s = /** @type {any} */ (state.obj(id));
        if (!s || !scanner.isFort(s) || scanner.isCritical(s)) continue;
        const want = targetHits(room, s);
        if (s.hits >= want) continue;
        deficit += want - s.hits;
        list.push(s);
    }
    list.sort((a, b) => (a.hits / targetHits(room, a)) - (b.hits / targetHits(room, b)) || (a.id < b.id ? -1 : 1));
    return { list, deficit };
}

/**
 * @param {import('../contracts/mission').PlanContext} plan
 * @param {import('../contracts/mission').Mission[]} out
 */
function generate(plan, out) {
    const { rc, intel, state: rs, census } = plan;
    if (rs.op === 'EMERGENCY') return;
    const mode = policyRules.fortifyMode(plan.policy);
    if (mode === 'off') return;
    const room = rc.room;
    const { list, deficit } = queue(room);
    if (list.length === 0) return;

    const id = `fortify:${rc.name}`;
    const working = census(id).count > 0;
    const gate = deficit >= minBacklog(intel.energyCapacityAvailable);
    if (!working && !gate) return;

    const creeps = intel.hostiles.length > 0 ? 2 : 1;
    const allowSpawn = mode === 'on' && gate;
    const t = list[0];
    out.push({
        id, type: 'fortify', home: rc.name, room: rc.name, archetype: 'worker',
        demand: { work: DESIRED_WORK, minCreeps: creeps, maxCreeps: creeps }, spawn: allowSpawn ? 'pool' : false,
        targetId: t.id, pos: t.pos,
        data: { sourceIds: intel.energySourceIds, allowPartial: true, targetHits: targetHits(room, t) },
        priority: allowSpawn ? 55 : 35
    });
}

/** @type {import('../contracts/mission').MissionType['nextTask']} */
function nextTask(creep, m, rc) {
    state.update(creep);
    const data = /** @type {any} */ (m.data || {});
    if (creep.memory.s === 'working') {
        let target = /** @type {any} */ (state.obj(data.cur || m.targetId));
        if (!target || target.hits >= (data.targetHits || target.hitsMax)) {
            // Done before the next refresh: move on to the next weakest wall
            // (kept in data, which this type owns; the planner owns targetId).
            target = queue(rc.room).list[0];
            if (!target) return null;
            data.cur = target.id;
            data.targetHits = targetHits(rc.room, target);
        }
        return vacate(creep, 'repair', target, 3) || { a: 'repair', i: target.id };
    }
    return gather(creep, rc, { allowedIds: data.sourceIds || null, allowPartial: !!data.allowPartial });
}

module.exports = { type: 'fortify', generate, nextTask, minBacklog };
