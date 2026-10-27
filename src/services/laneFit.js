// @ts-check
'use strict';

const roomData = require('./roomData');
const { pack, px, py, range } = require('./laneGeo');

/**
 * Lane fit: where the next spawns, towers and extensions go in a room that
 * already has a core lane (services/lanes). Semi-manual mode for hand-built
 * rooms: the lane is the plan. Every slot is a free tile next to the lane, so
 * whatever is built there is a lane stop. Reshape the lane by hand (demolish,
 * add roads) and plan.lanes finds the new one; the slots follow it.
 *
 * A slot is a tile next to a lane tile that:
 * - is not a lane tile, a road, a wall, or taken by a structure or site
 *   (a lone rampart is fine), and is 2+ tiles from the room edge;
 * - is not next to a source, mineral or the controller (miners, upgraders),
 *   or next to storage or the terminal (the hub stays open for other creeps);
 * - has no flag named NOBUILD* on it (manual veto).
 *
 * Order: closest to the head along the lane first (on a loop, either way
 * round), so what is built is always the stretch the hauler walks least.
 * Spawns take the closest slots. Towers take the slots nearest storage (the
 * core attackers go for; tower damage falls off past range 5), skipping
 * slots next to another tower while others are left. Extensions take the rest.
 *
 * A pick is kept only if every structure, source, the controller and every
 * room exit that the head could reach before can still be reached after it.
 */

const TYPES = [STRUCTURE_SPAWN, STRUCTURE_TOWER, STRUCTURE_EXTENSION];
const NOBUILD = 'NOBUILD';
const EDGE = 2;

/**
 * @typedef {import('./laneStore').Lane} Lane
 * @typedef {{p: number, d: number}} Slot          d = lane distance from the head
 * @typedef {{x: number, y: number, type: string, d: number}} Pick
 */

/** @param {Structure|ConstructionSite} s */
function walkable(s) {
    const t = s.structureType;
    return t === STRUCTURE_ROAD || t === STRUCTURE_CONTAINER || t === STRUCTURE_RAMPART;
}

/**
 * Room facts, read once per plan.
 * @param {Room} room
 */
function survey(room) {
    const terrain = room.getTerrain();
    /** @type {Set<number>} */ const blocked = new Set();   // can't walk through
    /** @type {Set<number>} */ const taken = new Set();     // can't build on
    /** @type {Set<number>} */ const keep = new Set();      // must stay free
    /** @type {number[]} */ const access = [];              // must stay reachable
    const around = (/** @type {RoomPosition} */ pos) => {
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) keep.add(pack(pos.x + dx, pos.y + dy));
    };
    for (const s of roomData.structures(room)) {
        const p = pack(s.pos.x, s.pos.y);
        if (s.structureType !== STRUCTURE_RAMPART) taken.add(p);
        if (walkable(s)) continue;
        blocked.add(p);
        if (s.structureType !== STRUCTURE_WALL) access.push(p);
    }
    for (const site of roomData.sites(room)) {
        const p = pack(site.pos.x, site.pos.y);
        taken.add(p);
        if (!walkable(site)) blocked.add(p);
    }
    for (const o of /** @type {Array<{pos: RoomPosition}>} */ ([]).concat(roomData.sources(room), roomData.minerals(room))) {
        const p = pack(o.pos.x, o.pos.y);
        blocked.add(p);
        taken.add(p);
        access.push(p);
        around(o.pos);
    }
    if (room.controller) around(room.controller.pos);
    if (room.storage) around(room.storage.pos);
    if (room.terminal) around(room.terminal.pos);
    for (const f of roomData.flags(room)) if (f.name.indexOf(NOBUILD) === 0) keep.add(pack(f.pos.x, f.pos.y));
    return { terrain, blocked, taken, keep, access };
}

/** @typedef {ReturnType<typeof survey>} Survey */

/**
 * Free tiles next to the lane, closest to the head first.
 * @param {Survey} sv
 * @param {Lane} lane
 * @returns {Slot[]}
 */
function slots(sv, lane) {
    const n = lane.path.length;
    const onLane = new Set(lane.path);
    /** @type {Map<number, number>} */
    const best = new Map();
    lane.path.forEach((tile, i) => {
        const d = lane.loop ? Math.min(i, n - i) : i;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const x = px(tile) + dx;
                const y = py(tile) + dy;
                if (x < EDGE || x > 49 - EDGE || y < EDGE || y > 49 - EDGE) continue;
                const p = pack(x, y);
                if (onLane.has(p) || sv.taken.has(p) || sv.keep.has(p)) continue;
                if (sv.terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
                if (!best.has(p) || d < /** @type {number} */ (best.get(p))) best.set(p, d);
            }
        }
    });
    return Array.from(best, ([p, d]) => ({ p, d })).sort((a, b) => (a.d - b.d) || (a.p - b.p));
}

/**
 * Tiles reachable from `from` without crossing `blocked` or `extra`.
 * @param {Survey} sv
 * @param {number} from
 * @param {Set<number>} extra
 */
function reach(sv, from, extra) {
    const seen = new Uint8Array(2500);
    const queue = [from];
    seen[from] = 1;
    while (queue.length) {
        const p = /** @type {number} */ (queue.pop());
        const x = px(p);
        const y = py(p);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;
                const q = pack(nx, ny);
                if (seen[q] || sv.blocked.has(q) || extra.has(q) || sv.terrain.get(nx, ny) === TERRAIN_MASK_WALL) continue;
                seen[q] = 1;
                queue.push(q);
            }
        }
    }
    return seen;
}

/**
 * What the head can reach: access objects with a walkable neighbour reached,
 * and exit sides with a reached edge tile.
 * @param {Survey} sv
 * @param {Uint8Array} seen
 */
function reachable(sv, seen) {
    const out = [];
    for (const a of sv.access) {
        let ok = false;
        for (let dx = -1; dx <= 1 && !ok; dx++) {
            for (let dy = -1; dy <= 1 && !ok; dy++) {
                const x = px(a) + dx;
                const y = py(a) + dy;
                if ((dx || dy) && x >= 0 && x <= 49 && y >= 0 && y <= 49 && seen[pack(x, y)]) ok = true;
            }
        }
        if (ok) out.push(`a${a}`);
    }
    const sides = [[0, 0, 1, 0], [0, 49, 1, 0], [0, 0, 0, 1], [49, 0, 0, 1]];
    sides.forEach(([x0, y0, sx, sy], i) => {
        for (let k = 0; k < 50; k++) {
            if (seen[pack(x0 + sx * k, y0 + sy * k)]) {
                out.push(`e${i}`);
                break;
            }
        }
    });
    return out;
}

/** How many more of each type the RCL allows (built + sites counted). @param {Room} room */
function need(room) {
    const rcl = room.controller ? room.controller.level : 0;
    /** @type {Record<string, number>} */
    const out = {};
    const sites = roomData.sites(room);
    for (const type of TYPES) {
        const allowed = (CONTROLLER_STRUCTURES[type] && CONTROLLER_STRUCTURES[type][rcl]) || 0;
        const have = roomData.byType(room, type).length + sites.filter(s => s.structureType === type).length;
        out[type] = Math.max(0, allowed - have);
    }
    return out;
}

/**
 * Picks the next sites, at most `budget` of them.
 * @param {Room} room
 * @param {Lane} lane
 * @param {number} budget
 * @returns {{picks: Pick[], need: Record<string, number>, slots: number}}
 */
function plan(room, lane, budget) {
    const sv = survey(room);
    const want = need(room);
    const free = slots(sv, lane);
    /** @type {Pick[]} */
    const picks = [];
    /** @type {Set<number>} */
    const planned = new Set();
    const before = reachable(sv, reach(sv, lane.head, planned));
    const towers = roomData.myByType(room, STRUCTURE_TOWER).map(t => pack(t.pos.x, t.pos.y))
        .concat(roomData.sites(room).filter(s => s.structureType === STRUCTURE_TOWER).map(s => pack(s.pos.x, s.pos.y)));
    const core = room.storage ? pack(room.storage.pos.x, room.storage.pos.y) : lane.head;
    const crowded = (/** @type {number} */ p) => (towers.some(t => range(p, t) <= 1) ? 1 : 0);

    /** @param {Slot} s */
    const safe = (s) => {
        planned.add(s.p);
        const after = new Set(reachable(sv, reach(sv, lane.head, planned)));
        if (before.every(k => after.has(k))) return true;
        planned.delete(s.p);
        return false;
    };

    for (const type of TYPES) {
        let left = want[type];
        while (left > 0 && picks.length < budget) {
            const open = free.filter(s => !planned.has(s.p));
            const order = type === STRUCTURE_TOWER
                ? open.slice().sort((a, b) => (crowded(a.p) - crowded(b.p)) || (range(a.p, core) - range(b.p, core)) || (a.d - b.d) || (a.p - b.p))
                : open;
            const pick = order.find(safe);
            if (!pick) break;
            picks.push({ x: px(pick.p), y: py(pick.p), type, d: pick.d });
            if (type === STRUCTURE_TOWER) towers.push(pick.p);
            left--;
        }
    }
    return { picks, need: want, slots: free.length };
}

module.exports = { plan, need, slots, survey, TYPES, NOBUILD };
