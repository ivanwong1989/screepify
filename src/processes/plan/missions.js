// @ts-check
'use strict';

const cache = require('../../services/cache');
const log = require('../../services/log');
const registry = require('../../missions/index');

/**
 * Mission planning (port of v1 overseer.missions.generate).
 *
 * Runs the mission generators for a room and stores the result on heap; the
 * kernel's context hands the stored list to every process on the ticks in
 * between, so planning can run on a cadence (config: processes.plan.missions.every).
 *
 * A generator that throws is skipped for that pass; the others still run.
 *
 * Each generator also has its own refresh interval (v1 missionThrottle,
 * config.missions.every). Between refreshes its last output is reused. All
 * generators refresh at once when the room changes in a way that matters
 * (see `roomKey`), and a generator can add its own key (`registry` entry `key`).
 */

/**
 * @param {string} roomName
 * @returns {{list: import('../../contracts/mission').Mission[], byId: Record<string, import('../../contracts/mission').Mission>, t: number}|undefined}
 */
function stored(roomName) {
    return cache.store('room.missions')[roomName];
}

/**
 * Sources worth static mining (v1 "efficient sources").
 * @param {import('../sense/intel').RoomIntel} intel
 * @param {number} budget
 */
function efficientSources(intel, budget) {
    const potentialWork = Math.max(1, Math.min(7, 1 + Math.floor((Math.max(200, budget || 0) - 200) / 100)));
    const needed = Math.ceil(5 / potentialWork);
    const set = new Set();
    for (const s of intel.sources) {
        const viable = needed <= s.availableSpaces;
        if (viable && (budget > 300 || !!s.containerId)) set.add(s.id);
    }
    // Bootstrap: allow the most open viable source so the first haulers have work.
    if (set.size === 0) {
        let best = null;
        for (const s of intel.sources) {
            if (needed > s.availableSpaces) continue;
            if (!best || s.availableSpaces > best.availableSpaces) best = s;
        }
        if (best) set.add(best.id);
    }
    return set;
}

/**
 * Changes that make every generator refresh right away: room state, policy,
 * RCL, energy capacity (body budgets), construction sites, hostiles present.
 * @param {import('../../contracts/ctx').RoomCtx} rc
 */
function roomKey(rc) {
    const i = /** @type {import('../sense/intel').RoomIntel} */ (rc.intel);
    const s = /** @type {import('../sense/intel').RoomState} */ (rc.state);
    const p = rc.policy;
    const rcl = rc.room.controller ? rc.room.controller.level : 0;
    return `${s.op}|${s.economy}|${p ? p.state : ''}|${p ? p.phase : ''}|${rcl}|` +
        `${i.energyCapacityAvailable}|${i.sites.length}|${i.hostiles.length > 0 ? 1 : 0}`;
}

/**
 * Builds the room's missions now.
 * @param {import('../../contracts/ctx').TickContext} ctx
 * @param {import('../../contracts/ctx').RoomCtx} rc
 */
function plan(ctx, rc) {
    const intel = rc.intel;
    const rs = rc.state;
    if (!intel || !rs) return [];
    const budget = rs.op === 'EMERGENCY' ? Math.max(intel.energyAvailable, 300) : intel.energyCapacityAvailable;
    const census = rc.census;
    /** @type {import('../../contracts/mission').PlanContext} */
    const planCtx = {
        rc, ctx, intel, state: rs, policy: rc.policy, budget,
        efficientSources: efficientSources(intel, budget),
        census(id) {
            const t = census && census.byMissionAll[id];
            return t ? { count: t.count, work: t.work, carry: t.carry } : { count: 0, work: 0, carry: 0 };
        }
    };
    const every = ctx.config.missions.every;
    const last = cache.store('plan.generators');
    const roomLast = last[rc.name] || (last[rc.name] = {});
    const rk = roomKey(rc);
    /** @type {import('../../contracts/mission').Mission[]} */
    const out = [];
    for (const g of registry.generators) {
        const key = g.key ? `${rk}|${g.key(planCtx)}` : rk;
        const prev = roomLast[g.name];
        const interval = every[g.name] || every.default || 1;
        if (prev && prev.key === key && ctx.time - prev.t < interval) {
            for (const m of prev.out) out.push(m);
            continue;
        }
        /** @type {import('../../contracts/mission').Mission[]} */
        const mine = [];
        try {
            g.generate(planCtx, mine);
        } catch (e) {
            log.throttled(`gen:${rc.name}:${g.name}`, 100, () =>
                log.error(`mission generator ${g.name} failed in ${rc.name}:`, (e && /** @type {any} */ (e).stack) || e));
            delete roomLast[g.name];
            continue;
        }
        roomLast[g.name] = { t: ctx.time, key, out: mine };
        for (const m of mine) out.push(m);
    }
    return out;
}

/**
 * Publishes a mission list for a room (heap + ctx).
 * @param {import('../../contracts/ctx').RoomCtx} rc
 * @param {import('../../contracts/mission').Mission[]} list
 */
function publish(rc, list) {
    /** @type {Record<string, import('../../contracts/mission').Mission>} */
    const byId = {};
    for (const m of list) byId[m.id] = m;
    cache.store('room.missions')[rc.name] = { list, byId, t: Game.time };
    rc.missions = list;
    rc.missionsById = byId;
}

/** @type {import('../../contracts/process').Process & Record<string, any>} */
module.exports = {
    id: 'plan.missions',
    phase: 'PLAN',
    scope: 'room',
    kinds: ['owned', 'bootstrap'],
    tier: 'normal',
    priority: 10,
    every: 2,
    run(ctx, rc) {
        publish(rc, plan(ctx, rc));
    },
    plan,
    roomKey,
    publish,
    stored,
    efficientSources
};
