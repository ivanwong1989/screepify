// @ts-check
'use strict';

const census = require('../sense/census');
const missionsProc = require('./missions');
const registry = require('../../missions/index');
const state = require('../../missions/shared/state');
const { pack, range } = require('../../services/pos');

/**
 * Creep ↔ mission assignment (port of v1 tasker steps 2–4.5 and overseer
 * reassignWorkers). Runs every tick but only touches creeps whose assignment
 * must change; tasks themselves are handed out by the creep runner.
 *
 * Order (v1):
 * 1. reassign workers: upgraders → build deficits (keep one upgrader); parked → deficits
 * 2. release creeps whose mission vanished or no longer fits them
 * 3. preempt idle:upgrade, then upgrade missions, when higher-priority work is underfilled
 * 4. idle creeps take the best underfilled mission (highest priority, then closest)
 * 5. idle creeps away from home walk home
 */

/**
 * @typedef {{mission: import('../../contracts/mission').Mission, count: number, work: number, carry: number, claim: number}} Status
 */

/** @param {import('../../contracts/mission').Mission} m */
function headcount(m) {
    const d = m.demand;
    if (Number.isFinite(d.maxCreeps)) return /** @type {number} */ (d.maxCreeps);
    if (Number.isFinite(d.minCreeps)) return d.minCreeps;
    return 0;
}

/** @param {Status} st */
function underfilled(st) {
    const d = st.mission.demand;
    const min = d.minCreeps || 0;
    const max = Number.isFinite(d.maxCreeps) ? /** @type {number} */ (d.maxCreeps) : null;
    const work = d.work || 0;
    const carry = d.carry || 0;
    const claim = d.claim || 0;
    if (max !== null && st.count >= max) return false;
    if (st.count < min) return true;
    if (st.work < work || st.carry < carry || st.claim < claim) return true;
    const hasFloor = min > 0 || work > 0 || carry > 0 || claim > 0;
    return !hasFloor && max !== null && st.count < max;
}

/**
 * @param {Status} st
 * @param {Creep} creep
 * @param {number} sign
 */
function count(st, creep, sign) {
    const p = census.parts(creep);
    st.count += sign;
    st.work += sign * p.work;
    st.carry += sign * p.carry;
    st.claim += sign * p.claim;
}

/**
 * Stable sort by priority, highest first.
 * @param {import('../../contracts/mission').Mission[]} list
 */
function byPriority(list) {
    return list.map((m, i) => ({ m, i }))
        .sort((a, b) => ((b.m.priority || 0) - (a.m.priority || 0)) || (a.i - b.i))
        .map(e => e.m);
}

/**
 * @param {import('../../contracts/mission').Mission} m
 * @returns {RoomPosition|null}
 */
function missionPos(m) {
    if (m.pos) return m.pos;
    if (m.targetId) {
        const o = /** @type {any} */ (Game.getObjectById(/** @type {any} */ (m.targetId)));
        if (o && o.pos) return o.pos;
    }
    return null;
}

/**
 * @param {Creep} creep
 * @param {import('../../contracts/mission').Mission} m
 * @param {string} home
 */
function fits(creep, m, home) {
    if (registry.UNASSIGNABLE.has(m.type)) return false;
    if (m.archetype && m.archetype !== creep.memory.a) return false;
    const away = creep.room.name !== home;
    if (away && m.room === home) return false;
    const p = census.parts(creep);
    const n = registry.needs(m.type);
    if ((n.work && p.work === 0) || (n.carry && p.carry === 0) || (n.claim && p.claim === 0)) return false;
    return true;
}

/**
 * v1 findBestMission: first priority band with an underfilled mission that fits; closest wins.
 * @param {Creep} creep
 * @param {import('../../contracts/mission').Mission[]} sorted
 * @param {Record<string, Status>} status
 * @param {string} home
 */
function bestMission(creep, sorted, status, home) {
    let band = null;
    const candidates = [];
    for (const m of sorted) {
        const prio = m.priority || 0;
        if (band !== null && prio < band) break;
        if (!fits(creep, m, home)) continue;
        const st = status[m.id];
        if (!st || !underfilled(st)) continue;
        if (band === null) band = prio;
        candidates.push(m);
    }
    if (candidates.length <= 1) return candidates[0] || null;
    let best = candidates[0];
    let bestR = Infinity;
    for (const m of candidates) {
        const p = missionPos(m);
        if (!p) continue;
        const r = range(creep.pos, p);
        if (r < bestR) {
            bestR = r;
            best = m;
        }
    }
    return best;
}

/**
 * @param {Creep} creep
 * @param {import('../../contracts/mission').Mission} m
 * @param {Record<string, Status>} status
 */
function assign(creep, m, status) {
    const prev = creep.memory.m;
    if (prev && status[prev]) count(status[prev], creep, -1);
    creep.memory.m = m.id;
    creep.memory.s = 'init';
    delete creep.memory.t;
    count(status[m.id], creep, +1);
}

/**
 * @param {import('../../contracts/ctx').TickContext} ctx
 * @param {import('../../contracts/ctx').RoomCtx} rc
 */
function run(ctx, rc) {
    if (!rc.missions) missionsProc.publish(rc, missionsProc.plan(ctx, rc));
    const missions = rc.missions || [];
    const c = rc.census;
    if (!c) return;
    const home = rc.name;

    /** @type {Record<string, Status>} */
    const status = {};
    for (const m of missions) status[m.id] = { mission: m, count: 0, work: 0, carry: 0, claim: 0 };
    /** @type {Record<string, Creep[]>} */
    const byMission = {};
    for (const creep of c.active) {
        const id = creep.memory.m;
        if (!id || !status[id]) continue;
        count(status[id], creep, +1);
        (byMission[id] || (byMission[id] = [])).push(creep);
    }

    // 1a) Upgraders → build deficits (keep one upgrader).
    if (rc.intel && rc.intel.sites.length > 0 && status['upgrade:controller']) {
        const upgraders = byMission['upgrade:controller'] || [];
        let available = upgraders.length - 1;
        for (const m of byPriority(missions.filter(x => x.type === 'build'))) {
            if (available <= 0) break;
            let deficit = Math.max(0, headcount(m) - status[m.id].count);
            while (deficit > 0 && available > 0) {
                const creep = upgraders.pop();
                if (!creep) break;
                assign(creep, m, status);
                deficit--;
                available--;
            }
        }
    }
    // 1b) Parked creeps → deficits for their archetype.
    const parked = (byMission['decongest:parking'] || []).filter(cr => cr.memory.m === 'decongest:parking');
    if (parked.length > 0) {
        for (const m of byPriority(missions)) {
            if (parked.length === 0) break;
            if (m.id === 'decongest:parking' || registry.UNASSIGNABLE.has(m.type)) continue;
            let deficit = headcount(m) - status[m.id].count;
            for (let i = parked.length - 1; i >= 0 && deficit > 0; i--) {
                if (parked[i].memory.a !== m.archetype) continue;
                assign(parked[i], m, status);
                parked.splice(i, 1);
                deficit--;
            }
        }
    }

    // 2) Release creeps whose mission is gone or doesn't fit.
    for (const creep of c.active) {
        const id = creep.memory.m;
        if (!id) continue;
        const st = status[id];
        if (!st) {
            state.release(creep);
            creep.say('?');
            continue;
        }
        const m = st.mission;
        if ((m.archetype && m.archetype !== creep.memory.a) || (creep.room.name !== home && m.room === home)) {
            count(st, creep, -1);
            state.release(creep);
        }
    }

    // 3) Preemption: idle:upgrade, then upgrade missions, yield to underfilled higher-priority work.
    /**
     * @param {number} floor
     * @param {Set<string>} exclude
     */
    const higherUnderfilled = (floor, exclude) => {
        for (const id in status) {
            if (exclude.has(id)) continue;
            const st = status[id];
            if ((st.mission.priority || 0) <= floor) continue;
            if (registry.UNASSIGNABLE.has(st.mission.type)) continue;
            if (underfilled(st)) return true;
        }
        return false;
    };
    /** @param {Set<string>} ids */
    const releaseAll = (ids) => {
        for (const creep of c.active) {
            const id = creep.memory.m;
            if (!id || !ids.has(id)) continue;
            count(status[id], creep, -1);
            state.release(creep);
        }
    };
    const idle = status['idle:upgrade'];
    if (idle && higherUnderfilled(idle.mission.priority, new Set(['idle:upgrade']))) releaseAll(new Set(['idle:upgrade']));
    const upgradeIds = new Set(missions.filter(m => m.type === 'upgrade' && m.id !== 'idle:upgrade').map(m => m.id));
    if (upgradeIds.size > 0) {
        for (const id of upgradeIds) {
            if (higherUnderfilled(status[id].mission.priority || 0, upgradeIds)) {
                releaseAll(upgradeIds);
                break;
            }
        }
    }

    // 4) Idle creeps take work.
    const sorted = byPriority(missions);
    for (const creep of c.active) {
        if (creep.memory.m) continue;
        const best = bestMission(creep, sorted, status, home);
        if (best) {
            assign(creep, best, status);
            continue;
        }
        // 5) Nothing to do away from home: walk home.
        if (creep.room.name !== home) {
            const homeRoom = Game.rooms[home];
            const target = homeRoom && homeRoom.controller ? homeRoom.controller.pos : new RoomPosition(25, 25, home);
            creep.memory.t = { a: 'move', p: pack(target), n: 5 };
        } else if (creep.memory.t && creep.memory.t.a !== 'move') {
            delete creep.memory.t;
        }
    }
}

/** @type {import('../../contracts/process').Process & Record<string, any>} */
module.exports = {
    id: 'plan.assignment',
    phase: 'PLAN',
    scope: 'room',
    kinds: ['owned', 'bootstrap'],
    tier: 'critical',
    priority: 20,
    run,
    underfilled,
    bestMission,
    headcount
};
