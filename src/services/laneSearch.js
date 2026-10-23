// @ts-check
'use strict';

const { pack, px, py, range, adjacent } = require('./laneGeo');

/**
 * Core lane path search (part of the v1 mission.logisticsCoreV2 port; see
 * services/lanes for the overview). Pure functions over a room survey.
 */

const PLAIN = 20;
const SWAMP = 45;
const ROAD_BASE = 4;
const ROAD_MAX_BONUS = 3;
const MAX_WAYPOINTS = 28;
const MAX_EVALUATIONS = 36;
const MAX_LOOP_WAYPOINTS = 8;
const LOOP_RANGE = 3;
const LOOP_JOIN_MAX = 6;

/**
 * @typedef {import('./lanes').Survey} Survey
 * @typedef {import('./lanes').LaneTarget} LaneTarget
 * @typedef {import('./lanes').BuiltLane} BuiltLane
 */

/**
 * Lane cost matrix (v1 buildRoomCostMatrix).
 * @param {Survey} sv
 * @param {LaneTarget[]} tgts
 * @param {number} head
 * @param {number} end
 */
function matrix(sv, tgts, head, end) {
    const m = new PathFinder.CostMatrix();
    for (let y = 0; y < 50; y++) {
        for (let x = 0; x < 50; x++) {
            const t = sv.terrain.get(x, y);
            m.set(x, y, t === TERRAIN_MASK_WALL ? 255 : t === TERRAIN_MASK_SWAMP ? SWAMP : PLAIN);
        }
    }
    for (const p of sv.roads) {
        let cost = ROAD_BASE - Math.min(ROAD_MAX_BONUS, adjacent(p, tgts));
        if (p === head || p === end) cost = 1;
        m.set(px(p), py(p), Math.max(1, cost));
    }
    for (const p of sv.blocked) if (!sv.roads.has(p)) m.set(px(p), py(p), 255);
    return m;
}

/**
 * Path from `a` to `b` (excluding `a`, including `b`), or null.
 * @param {Survey} sv
 * @param {CostMatrix} m
 * @param {number} a
 * @param {number} b
 * @returns {number[]|null}
 */
function segment(sv, m, a, b) {
    const name = sv.room.name;
    const res = PathFinder.search(new RoomPosition(px(a), py(a), name), { pos: new RoomPosition(px(b), py(b), name), range: 0 }, {
        maxOps: 4000, plainCost: PLAIN, swampCost: SWAMP,
        roomCallback: (rn) => (rn === name ? m : false)
    });
    if (!res || res.incomplete || !res.path || res.path.length === 0) return null;
    return res.path.map(p => pack(p.x, p.y));
}

/**
 * @param {number[]} path
 * @param {LaneTarget[]} tgts
 * @returns {{covered: number, weighted: number}}
 */
function coverage(path, tgts) {
    let covered = 0;
    let weighted = 0;
    for (const t of tgts) {
        const tp = pack(t.x, t.y);
        if (path.some(p => range(p, tp) <= 1)) {
            covered++;
            weighted += t.w;
        }
    }
    return { covered, weighted };
}

/** @param {number[]} path */
function repeats(path) {
    return new Set(path).size !== path.length;
}

/**
 * v1 comparePathScores: weighted coverage, then count, then loop, then shorter.
 * @param {{path: number[], covered: number, weighted: number, loop?: boolean}} a
 * @param {{path: number[], covered: number, weighted: number, loop?: boolean}|null} b
 */
function better(a, b) {
    if (!b) return true;
    if (a.weighted !== b.weighted) return a.weighted > b.weighted;
    if (a.covered !== b.covered) return a.covered > b.covered;
    if (!!a.loop !== !!b.loop) return !!a.loop;
    return a.path.length < b.path.length;
}

/**
 * Roads next to targets, most targets first, then closest to head + end.
 * @param {Survey} sv
 * @param {LaneTarget[]} tgts
 * @param {number} head
 * @param {number} end
 */
function waypoints(sv, tgts, head, end) {
    const keyed = [];
    for (const p of sv.roads) {
        const adj = adjacent(p, tgts);
        if (adj > 0 && p !== head && p !== end) keyed.push({ p, adj, d: range(p, head) + range(p, end) });
    }
    keyed.sort((a, b) => (b.adj - a.adj) || (a.d - b.d) || (a.p - b.p));
    return keyed.slice(0, MAX_WAYPOINTS).map(k => k.p);
}

/**
 * Best lane from head to a given end (v1 buildPath).
 * @param {Survey} sv
 * @param {LaneTarget[]} tgts
 * @param {number} head
 * @param {number} end
 * @returns {BuiltLane|null}
 */
function laneTo(sv, tgts, head, end) {
    const m = matrix(sv, tgts, head, end);
    const direct = segment(sv, m, head, end);
    if (!direct) return null;
    const directPath = [head].concat(direct);
    const directScore = Object.assign({ path: directPath }, coverage(directPath, tgts));
    const loopEligible = range(head, end) <= LOOP_RANGE;
    /** @type {{path: number[], covered: number, weighted: number}|null} */
    let best = loopEligible ? null : directScore;
    let evals = 1;
    /** @param {number[]} path */
    const consider = (path) => {
        if (repeats(path)) return;
        const cand = Object.assign({ path }, coverage(path, tgts));
        if (better(cand, best)) best = cand;
    };

    const wps = waypoints(sv, tgts, head, end);
    for (const w of wps) {
        if (evals >= MAX_EVALUATIONS) break;
        const a = segment(sv, m, head, w);
        if (!a) continue;
        const b = segment(sv, m, w, end);
        if (!b) continue;
        evals++;
        consider([head].concat(a, b));
    }
    if (loopEligible && evals < MAX_EVALUATIONS) {
        const loopWps = wps.slice(0, Math.max(2, Math.min(MAX_LOOP_WAYPOINTS, wps.length)));
        for (let i = 0; i < loopWps.length && evals < MAX_EVALUATIONS; i++) {
            const a = segment(sv, m, head, loopWps[i]);
            if (!a) continue;
            for (let j = 0; j < loopWps.length && evals < MAX_EVALUATIONS; j++) {
                if (i === j) continue;
                const b = segment(sv, m, loopWps[i], loopWps[j]);
                if (!b) continue;
                const c = segment(sv, m, loopWps[j], end);
                if (!c) continue;
                evals++;
                consider([head].concat(a, b, c));
            }
        }
        const chosen = /** @type {{path: number[], covered: number, weighted: number}|null} */ (best);
        if (!chosen || chosen.covered < directScore.covered) best = directScore;
    }

    const lane = /** @type {{path: number[], covered: number, weighted: number}} */ (best);
    let path = lane.path;
    let score = { covered: lane.covered, weighted: lane.weighted };
    let loop = false;
    // Loop join: tail within 3 of head and a short road back (head tile itself excluded).
    const tail = path[path.length - 1];
    if (range(tail, head) <= LOOP_RANGE) {
        const join = segment(sv, m, tail, head);
        if (join && join.length <= LOOP_JOIN_MAX) {
            const looped = path.concat(join.slice(0, join.length - 1));
            if (!repeats(looped)) {
                path = looped;
                score = coverage(looped, tgts);
                loop = true;
            }
        }
    }
    return { path, loop, covered: score.covered, weighted: score.weighted, end };
}

module.exports = { laneTo, better, coverage };
