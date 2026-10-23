// @ts-check
'use strict';

const roomData = require('./roomData');
const { pack, px, py, range } = require('./laneGeo');
const { laneTo, better } = require('./laneSearch');

/**
 * Core lane discovery (port of v1 mission.logisticsCoreV2 path building,
 * dev_make_missions_missions). Finds the road a core hauler walks so that it
 * passes next to as many spawns/extensions/towers as possible.
 *
 * - Head: a walkable tile next to storage and a spawn (and the terminal, and a
 *   link, when the room has them); else a road next to storage and a spawn;
 *   else any road next to storage. Without storage: a road next to a spawn.
 * - End: a flag named CORE_END* in the room, or found automatically: try road
 *   tiles that touch the most lane targets (plus "bridge" roads next to them,
 *   plus the farthest road) and keep the best lane.
 * - Lane between head and end: direct path, or via one or two "waypoint"
 *   roads, scored by weighted coverage (towers 98, spawns 96, extensions 95,
 *   power spawn 83, nuker 78), then coverage count, then loop, then length.
 * - Loop: when the lane ends within 3 tiles of the head and a ≤6-tile road
 *   joins them, the lane becomes a loop the hauler can circle in either direction.
 *
 * Costs: plain 20, swamp 45, road 4 minus 1 per adjacent target (min 1),
 * head/end road tiles 1, obstacles 255. Labs are never lane targets (v1:
 * labs get their own lane, porting plan P12).
 *
 * Positions are packed as y * 50 + x; lanes are single-room.
 */

const MAX_ENDPOINTS = 24;
const MAX_BRIDGES = 18;

const TARGET_TYPES = [STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_TOWER, STRUCTURE_POWER_SPAWN, STRUCTURE_NUKER];
/** @type {Record<string, number>} */
const WEIGHT = {
    [STRUCTURE_TOWER]: 98,
    [STRUCTURE_SPAWN]: 96,
    [STRUCTURE_EXTENSION]: 95,
    [STRUCTURE_LAB]: 86,
    [STRUCTURE_POWER_SPAWN]: 83,
    [STRUCTURE_NUKER]: 78
};

/**
 * @typedef {{id: string, x: number, y: number, w: number}} LaneTarget
 * @typedef {{path: number[], loop: boolean, covered: number, weighted: number, end: number}} BuiltLane
 */





/** @param {{pos: RoomPosition}} o */
function at(o) {
    return pack(o.pos.x, o.pos.y);
}

/** @param {Room} room @returns {LaneTarget[]} */
function targets(room) {
    /** @type {LaneTarget[]} */
    const out = [];
    for (const type of TARGET_TYPES) {
        for (const s of roomData.myByType(room, type)) {
            out.push({ id: s.id, x: s.pos.x, y: s.pos.y, w: WEIGHT[type] || 60 });
        }
    }
    return out;
}

/** @param {Structure|ConstructionSite} s */
function walkableStructure(s) {
    const t = s.structureType;
    if (t === STRUCTURE_ROAD || t === STRUCTURE_CONTAINER) return true;
    const r = /** @type {any} */ (s);
    return t === STRUCTURE_RAMPART && (r.my || r.isPublic);
}

/**
 * Room facts the search needs, read once.
 * @param {Room} room
 */
function survey(room) {
    const terrain = room.getTerrain();
    /** @type {Set<number>} */
    const roads = new Set();
    /** @type {Set<number>} */
    const blocked = new Set();
    for (const s of roomData.structures(room)) {
        if (s.structureType === STRUCTURE_ROAD) roads.add(at(s));
        else if (!walkableStructure(s)) blocked.add(at(s));
    }
    for (const site of roomData.sites(room)) {
        if (site.structureType !== STRUCTURE_ROAD && site.structureType !== STRUCTURE_CONTAINER) blocked.add(at(site));
    }
    /** @param {number} x @param {number} y */
    const walkable = (x, y) => x >= 0 && x <= 49 && y >= 0 && y <= 49 &&
        terrain.get(x, y) !== TERRAIN_MASK_WALL && !blocked.has(pack(x, y));
    return { room, terrain, roads, blocked, walkable };
}

/** @typedef {ReturnType<typeof survey>} Survey */


/**
 * Head tile and the structure the hauler loads from there (v1 selectHeadAnchor).
 * @param {Room} room
 * @param {Survey} sv
 * @param {number|null} endFlag
 * @returns {{head: number, sourceId: string}|null}
 */
function headAnchor(room, sv, endFlag) {
    const spawns = roomData.myByType(room, STRUCTURE_SPAWN);
    if (spawns.length === 0) return null;
    const toEnd = (/** @type {number} */ p) => (endFlag === null ? 0 : range(p, endFlag));
    const near = (/** @type {number} */ p, /** @type {any[]} */ list) => list.some(s => range(p, at(s)) <= 1);
    const storage = room.storage;
    if (storage) {
        const terminal = room.terminal;
        const links = roomData.myByType(room, STRUCTURE_LINK);
        const sp = at(storage);
        /** @type {number|null} */
        let best = null;
        /** @type {number[]} */
        let bestScore = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const x = storage.pos.x + dx;
                const y = storage.pos.y + dy;
                if (!sv.walkable(x, y)) continue;
                const p = pack(x, y);
                if (!near(p, spawns)) continue;
                if (terminal && range(p, at(terminal)) > 1) continue;
                if (links.length > 0 && !near(p, links)) continue;
                const minTo = (/** @type {any[]} */ list) => list.reduce((m, s) => Math.min(m, range(p, at(s))), Infinity);
                const score = [
                    sv.roads.has(p) ? -1 : 0,
                    toEnd(p),
                    minTo(spawns) + (links.length ? minTo(links) : 0) + (terminal ? range(p, at(terminal)) : 0)
                ];
                if (best === null || score[0] < bestScore[0] || (score[0] === bestScore[0] &&
                    (score[1] < bestScore[1] || (score[1] === bestScore[1] && score[2] < bestScore[2])))) {
                    best = p;
                    bestScore = score;
                }
            }
        }
        if (best !== null) return { head: best, sourceId: storage.id };
        /** @type {number|null} */
        let shared = null;
        let sharedRange = Infinity;
        /** @type {number|null} */
        let anyRoad = null;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const p = pack(storage.pos.x + dx, storage.pos.y + dy);
                if (!sv.roads.has(p) || p === sp) continue;
                if (anyRoad === null) anyRoad = p;
                if (near(p, spawns) && toEnd(p) < sharedRange) {
                    sharedRange = toEnd(p);
                    shared = p;
                }
            }
        }
        if (shared !== null) return { head: shared, sourceId: storage.id };
        return { head: anyRoad !== null ? anyRoad : sp, sourceId: storage.id };
    }
    /** @type {{head: number, sourceId: string}|null} */
    let bestRoad = null;
    let bestRange = Infinity;
    for (const spawn of spawns) {
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const p = pack(spawn.pos.x + dx, spawn.pos.y + dy);
                if (!sv.roads.has(p)) continue;
                if (toEnd(p) < bestRange) {
                    bestRange = toEnd(p);
                    bestRoad = { head: p, sourceId: spawn.id };
                }
            }
        }
    }
    return bestRoad || { head: at(spawns[0]), sourceId: spawns[0].id };
}








/**
 * Candidate lane ends (v1 getAutoLaneEndpointCandidates).
 * @param {Survey} sv
 * @param {LaneTarget[]} tgts
 * @param {number} head
 */
function endpoints(sv, tgts, head) {
    /** @type {Map<number, number>} */
    const service = new Map();
    for (const t of tgts) {
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                const p = pack(t.x + dx, t.y + dy);
                if (sv.roads.has(p)) service.set(p, (service.get(p) || 0) + t.w);
            }
        }
    }
    const byScore = (/** @type {{p: number, s: number}} */ a, /** @type {{p: number, s: number}} */ b) =>
        (b.s - a.s) || (range(b.p, head) - range(a.p, head)) || (a.p - b.p);
    const cands = Array.from(service, ([p, s]) => ({ p, s })).sort(byScore);
    /** @type {number[]} */
    const out = [];
    const seen = new Set([head]);
    for (const c of cands) {
        if (out.length >= MAX_ENDPOINTS) break;
        if (seen.has(c.p)) continue;
        seen.add(c.p);
        out.push(c.p);
    }
    // Bridge roads next to service roads, so a lane can reach past dense tiles.
    /** @type {Map<number, number>} */
    const bridge = new Map();
    for (const c of cands) {
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                const p = pack(px(c.p) + dx, py(c.p) + dy);
                if (!sv.roads.has(p) || seen.has(p)) continue;
                bridge.set(p, Math.max(bridge.get(p) || 0, c.s - 5));
            }
        }
    }
    const bridges = Array.from(bridge, ([p, s]) => ({ p, s })).sort(byScore);
    for (let i = 0; i < bridges.length && i < MAX_BRIDGES; i++) {
        if (seen.has(bridges[i].p)) continue;
        seen.add(bridges[i].p);
        out.push(bridges[i].p);
    }
    // The farthest road, so a straight base still finds its trunk.
    let far = -1;
    let farD = -1;
    for (const p of sv.roads) {
        if (p === head) continue;
        const d = range(p, head);
        if (d > farD || (d === farD && p < far)) {
            far = p;
            farD = d;
        }
    }
    if (far >= 0 && !seen.has(far)) out.push(far);
    return out;
}

/**
 * @typedef {Object} LaneJob  a lane search in progress (heap only)
 * @property {string} room
 * @property {number} head
 * @property {string} sourceId
 * @property {number|null} flag
 * @property {number[]} ends     candidate ends still to try
 * @property {BuiltLane|null} best
 */

/**
 * Starts a lane search for a room. Returns null when the room can't have a lane.
 * @param {Room} room
 * @returns {LaneJob|null}
 */
function start(room) {
    const sv = survey(room);
    const flagObj = roomData.flags(room).filter(f => f.name.indexOf('CORE_END') === 0)
        .sort((a, b) => (a.name < b.name ? -1 : 1))[0];
    const flag = flagObj ? at(flagObj) : null;
    const anchor = headAnchor(room, sv, flag);
    if (!anchor) return null;
    const ends = flag !== null ? [flag] : endpoints(sv, targets(room), anchor.head);
    return { room: room.name, head: anchor.head, sourceId: anchor.sourceId, flag, ends, best: null };
}

/**
 * Tries candidate ends until `stop()` says to yield. Returns true when finished.
 * @param {Room} room
 * @param {LaneJob} job
 * @param {() => boolean} stop
 */
function step(room, job, stop) {
    const sv = survey(room);
    const tgts = targets(room);
    while (job.ends.length > 0) {
        const end = /** @type {number} */ (job.ends.shift());
        const lane = laneTo(sv, tgts, job.head, end);
        if (lane && better(lane, job.best)) job.best = lane;
        if (stop()) break;
    }
    return job.ends.length === 0;
}

/**
 * Finds the room's core lane in one go (tests, console).
 * @param {Room} room
 */
function discover(room) {
    const job = start(room);
    if (!job) return null;
    step(room, job, () => false);
    return job;
}

/**
 * Which lane index serves each target: the closest path tile within range 1
 * (v1 buildStopsByIndex).
 * @param {number[]} path
 * @param {LaneTarget[]} tgts
 * @returns {Record<number, string[]>}
 */
function stops(path, tgts) {
    /** @type {Record<number, string[]>} */
    const out = {};
    for (const t of tgts) {
        const tp = pack(t.x, t.y);
        let bestI = -1;
        let bestR = Infinity;
        for (let i = 0; i < path.length; i++) {
            const r = range(path[i], tp);
            if (r <= 1 && r < bestR) {
                bestR = r;
                bestI = i;
            }
        }
        if (bestI >= 0) (out[bestI] || (out[bestI] = [])).push(t.id);
    }
    return out;
}

module.exports = { start, step, discover, stops, targets, pack, px, py, range, WEIGHT, survey, headAnchor, endpoints, laneTo };
