// @ts-check
'use strict';

const cache = require('./cache');

/**
 * Body recipes per archetype — ported from v1's room spawner so creeps come
 * out the same shape (DESIGN §11, keep-economy-behaviour rule).
 */

/** Energy caps per archetype (v1 "body budget restriction"). */
const BUDGET_CAP = {
    worker: 3000,
    mineralMiner: 3000,
    hauler: 4000,
    miningHauler: 4000,
    remote_worker: 3000,
    remote_hauler: 3000
};

const SORT_ORDER = {
    [TOUGH]: 0,
    [ATTACK]: 1, [RANGED_ATTACK]: 1, [WORK]: 1,
    [CARRY]: 2,
    [HEAL]: 3,
    [MOVE]: 4
};

/** @param {BodyPartConstant[]} body */
function sortBody(body) {
    body.sort((a, b) => {
        const oa = SORT_ORDER[a] !== undefined ? SORT_ORDER[a] : 99;
        const ob = SORT_ORDER[b] !== undefined ? SORT_ORDER[b] : 99;
        return oa - ob;
    });
    const healIndex = body.indexOf(HEAL);
    if (healIndex !== -1) {
        body.splice(healIndex, 1);
        body.push(HEAL);
    }
    return body;
}

/** @param {BodyPartConstant[]} body */
function cost(body) {
    let total = 0;
    for (let i = 0; i < body.length; i++) total += BODYPART_COST[body[i]] || 0;
    return total;
}

/** Static miner: W C M + up to 6 more WORK (7 WORK max, v1 margin over 5). */
/** @param {number} budget */
function miner(budget) {
    /** @type {BodyPartConstant[]} */
    const body = [WORK, CARRY, MOVE];
    let c = 200;
    let work = 1;
    while (c + 100 <= budget && work < 7) {
        body.push(WORK);
        c += 100;
        work++;
    }
    return sortBody(body);
}

/** Mobile miner: (W C M M) segments, max 5 WORK. */
/** @param {number} budget */
function mobileMiner(budget) {
    /** @type {BodyPartConstant[]} */
    const segment = [WORK, CARRY, MOVE, MOVE];
    if (budget < 250) {
        if (budget >= 200) return sortBody([WORK, CARRY, MOVE]);
        if (budget >= 150) return sortBody([WORK, MOVE]);
        if (budget >= 100) return sortBody([WORK]);
        return [MOVE];
    }
    /** @type {BodyPartConstant[]} */
    let body = segment.slice();
    let c = 250;
    let work = 1;
    while (c + 250 <= budget && body.length + 4 <= 50 && work + 1 <= 5) {
        body = body.concat(segment);
        c += 250;
        work++;
    }
    return sortBody(body);
}

/**
 * Hauler: (C M) pairs, capped by carry parts.
 * @param {number} budget
 * @param {number} [maxCarry]
 */
function hauler(budget, maxCarry) {
    const cap = Number.isFinite(maxCarry) && maxCarry > 0 ? maxCarry : Infinity;
    /** @type {BodyPartConstant[]} */
    const body = [];
    let c = 0;
    let carry = 0;
    while (c + 100 <= budget && body.length + 2 <= 50 && carry < cap) {
        body.push(CARRY, MOVE);
        c += 100;
        carry++;
    }
    if (body.length === 0) return [CARRY, MOVE];
    return sortBody(body);
}

/**
 * Active parts by type, per tick.
 * @param {Creep} creep
 * @returns {{work: number, carry: number, claim: number}}
 */
function activeParts(creep) {
    return cache.perTick(`parts:${creep.name}`, () => {
        let work = 0;
        let carry = 0;
        let claim = 0;
        for (const p of creep.body) {
            if (p.hits <= 0) continue;
            if (p.type === WORK) work++;
            else if (p.type === CARRY) carry++;
            else if (p.type === CLAIM) claim++;
        }
        return { work, carry, claim };
    });
}

/** Worker: (W C M) segments. */
/** @param {number} budget */
function worker(budget) {
    /** @type {BodyPartConstant[]} */
    const body = [];
    let c = 0;
    while (c + 200 <= budget && body.length + 3 <= 50) {
        body.push(WORK, CARRY, MOVE);
        c += 200;
    }
    if (body.length === 0) return [WORK, CARRY, MOVE];
    return sortBody(body);
}

/**
 * Road hauler for the core lane: 2 CARRY per MOVE, up to `maxCarry` (≤ 33)
 * (v1 generateRoadHaulerBody).
 * @param {number} budget
 * @param {number} [maxCarry]
 * @returns {BodyPartConstant[]}
 */
function roadHauler(budget, maxCarry) {
    const cap = Math.min(33, Number.isFinite(maxCarry) && /** @type {number} */ (maxCarry) > 0 ? /** @type {number} */ (maxCarry) : 33);
    for (let c = cap; c >= 1; c--) {
        const m = Math.ceil(c / 2);
        if (c + m <= 50 && (c + m) * 50 <= budget) {
            /** @type {BodyPartConstant[]} */
            const out = [];
            for (let i = 0; i < c; i++) out.push(CARRY);
            for (let i = 0; i < m; i++) out.push(MOVE);
            return out;
        }
    }
    return [CARRY, MOVE];
}

/** @returns {BodyPartConstant[]} */
function scout() {
    return [MOVE];
}

/**
 * Builds a body for an archetype.
 * @param {string} archetype
 * @param {number} budget
 * @param {{mode?: string, maxCarry?: number}} [opts]
 * @returns {BodyPartConstant[]}
 */
function build(archetype, budget, opts) {
    const o = opts || {};
    const capped = BUDGET_CAP[archetype] ? Math.min(budget, BUDGET_CAP[archetype]) : budget;
    switch (archetype) {
        case 'miner': return o.mode === 'mobile' ? mobileMiner(capped) : miner(capped);
        case 'hauler': return hauler(capped, o.maxCarry);
        case 'laneHauler': return roadHauler(capped, o.maxCarry);
        case 'miningHauler': return hauler(capped, o.maxCarry);
        case 'scout': return scout();
        case 'mineralMiner':
        case 'worker':
        default: return worker(capped);
    }
}

/**
 * @typedef {{body: BodyPartConstant[], cost: number, work: number, carry: number, move: number, claim: number}} BodyStats
 */

/**
 * Body plus part counts, memoised per tick.
 * @param {string} archetype
 * @param {number} budget
 * @param {{mode?: string, maxCarry?: number}} [opts]
 * @returns {BodyStats}
 */
function stats(archetype, budget, opts) {
    const o = opts || {};
    const key = `body:${archetype}:${budget}:${o.mode || ''}:${o.maxCarry || ''}`;
    return cache.perTick(key, () => {
        const body = build(archetype, budget, o);
        const out = { body, cost: 0, work: 0, carry: 0, move: 0, claim: 0 };
        for (const part of body) {
            out.cost += BODYPART_COST[part] || 0;
            if (part === WORK) out.work++;
            else if (part === CARRY) out.carry++;
            else if (part === MOVE) out.move++;
            else if (part === CLAIM) out.claim++;
        }
        return out;
    });
}

module.exports = { activeParts, build, stats, cost, sortBody, miner, mobileMiner, hauler, roadHauler, worker, BUDGET_CAP };
