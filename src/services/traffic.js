// @ts-check
'use strict';

const cache = require('./cache');
const roomData = require('./roomData');
const miningStations = require('./miningStations');

/**
 * Traffic management (port of v1 traffic/screeps-traffic-manager + trafficAdapter,
 * dev_make_missions_missions). Lets creeps swap with or shove creeps in their way
 * instead of waiting and repathing around them.
 *
 * Per tick:
 * 1. `movement.to` calls `register(creep, dir)`. That also issues the normal
 *    `creep.move(dir)`, so if `act.traffic` never runs, creeps move as before.
 * 2. Actions call `working(creep, pos, range)` once in range, so a shoved worker
 *    stays in range of its job when it can. `pin(creep)` means never shove it
 *    (harvesting creeps).
 * 3. `act.traffic` calls `resolve(room)` once per room after all creeps acted.
 *    For each creep with an intended tile it searches (depth-first) for a chain
 *    of my creeps that can step aside or swap, and issues those moves.
 *
 * All my creeps in the room can be moved out of the way (v1 enrolled every role)
 * unless pinned, fatigued, spawning or without MOVE parts.
 *
 * Differences from v1:
 * - Shove directions are tried in a fixed rotating order instead of
 *   Math.random (deterministic for tests and replays).
 * - Harvesting creeps are pinned (v1 could shove a miner off its container).
 * - Obstacles come from movement's cached structure matrix (255 = blocked).
 */

/** [dx, dy] for directions 1..8 */
const DELTA = [null, [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

/**
 * @typedef {Object} RoomTraffic
 * @property {Map<string, number>} intent      creep name → packed tile it wants
 * @property {Map<string, {x: number, y: number, range: number}>} area  working areas
 * @property {Set<string>} pinned
 */

/** @returns {Record<string, RoomTraffic>} */
function tick() {
    return cache.perTick('traffic', () => ({}));
}

/** @param {string} roomName @returns {RoomTraffic} */
function roomState(roomName) {
    const t = tick();
    return t[roomName] || (t[roomName] = { intent: new Map(), area: new Map(), pinned: new Set() });
}

/** @param {number} x @param {number} y */
function pack(x, y) {
    return y * 50 + x;
}

/**
 * Records the creep's intended step and issues the move.
 * @param {Creep} creep
 * @param {DirectionConstant} dir
 * @returns {ScreepsReturnCode}
 */
function register(creep, dir) {
    const d = DELTA[dir];
    if (d) {
        const x = creep.pos.x + d[0];
        const y = creep.pos.y + d[1];
        const owner = miningStations.reserved(creep.pos.roomName)[`${x}:${y}:${creep.pos.roomName}`];
        if (owner && owner !== creep.name) return ERR_BUSY;
        if (x >= 0 && x <= 49 && y >= 0 && y <= 49) roomState(creep.pos.roomName).intent.set(creep.name, pack(x, y));
    }
    return creep.move(dir);
}

/**
 * The creep is working at `pos` within `range`; if shoved, prefer tiles still in range.
 * @param {Creep} creep
 * @param {RoomPosition} pos
 * @param {number} range
 */
function working(creep, pos, range) {
    if (pos.roomName !== creep.pos.roomName) return;
    roomState(creep.pos.roomName).area.set(creep.name, { x: pos.x, y: pos.y, range });
}

/** Never shove this creep this tick. @param {Creep} creep */
function pin(creep) {
    roomState(creep.pos.roomName).pinned.add(creep.name);
}

/** @param {string} name */
function nameHash(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return h >>> 0;
}

/**
 * Resolves this tick's moves in a room. Returns how many creeps it moved aside.
 * @param {Room} room
 * @returns {number}
 */
function resolve(room) {
    const st = tick()[room.name];
    if (!st || st.intent.size === 0) return 0;
    const creeps = roomData.myCreeps(room).filter(c => !c.spawning);
    if (creeps.length < 2) return 0;

    const terrain = room.getTerrain();
    // Required here, not at the top: movement requires this module.
    const costs = require('./movement').structureMatrix(room);
    /** @type {Map<number, Creep>} tile → creep that ends there */
    const map = new Map();
    /** @type {Map<string, number>} creep → tile it ends on */
    const matched = new Map();
    /** @type {Map<string, number[]>} */
    const movesCache = new Map();

    /** @param {Creep} c @param {number} p */
    const assign = (c, p) => {
        matched.set(c.name, p);
        map.set(p, c);
    };
    for (const c of creeps) assign(c, pack(c.pos.x, c.pos.y));

    /** @param {Creep} c */
    const canMove = (c) => c.fatigue === 0 && !st.pinned.has(c.name) && c.getActiveBodyparts(MOVE) > 0;

    /** @param {number} x @param {number} y */
    const reserved = miningStations.reserved(room.name);
    const valid = (x, y, c) => x > 0 && x < 49 && y > 0 && y < 49 &&
        terrain.get(x, y) !== TERRAIN_MASK_WALL && costs.get(x, y) < 255 &&
        (!reserved[`${x}:${y}:${room.name}`] || reserved[`${x}:${y}:${room.name}`] === c.name);

    /** @param {Creep} c @returns {number[]} */
    const possibleMoves = (c) => {
        const hit = movesCache.get(c.name);
        if (hit) return hit;
        /** @type {number[]} */
        const out = [];
        if (canMove(c)) {
            const want = st.intent.get(c.name);
            if (want !== undefined) {
                if (valid(want % 50, Math.floor(want / 50), c)) out.push(want);
            } else {
                const area = st.area.get(c.name);
                const later = [];
                const start = (Game.time + nameHash(c.name)) % 8;
                for (let i = 0; i < 8; i++) {
                    const d = /** @type {number[]} */ (DELTA[1 + ((start + i) % 8)]);
                    const x = c.pos.x + d[0];
                    const y = c.pos.y + d[1];
                    if (!valid(x, y, c)) continue;
                    if (area && Math.max(Math.abs(area.x - x), Math.abs(area.y - y)) > area.range) later.push(pack(x, y));
                    else out.push(pack(x, y));
                }
                for (const p of later) out.push(p);
            }
        }
        movesCache.set(c.name, out);
        return out;
    };

    /**
     * Finds a tile for `c`, moving occupants along if needed. Score counts
     * creeps that reach their intended tile minus those pushed off it.
     * @param {Creep} c
     * @param {number} score
     * @param {Set<string>} visited
     * @returns {number}
     */
    const dfs = (c, score, visited) => {
        visited.add(c.name);
        const moves = possibleMoves(c);
        const empty = moves.filter(p => !map.has(p));
        const taken = moves.filter(p => map.has(p));
        const want = st.intent.get(c.name);
        for (const p of empty.concat(taken)) {
            let s = score;
            if (want === p) s++;
            const occupant = map.get(p);
            if (!occupant) {
                if (s > 0) assign(c, p);
                return s;
            }
            if (visited.has(occupant.name)) continue;
            if (st.intent.get(occupant.name) === p) s--;
            const r = dfs(occupant, s, visited);
            if (r > 0) {
                assign(c, p);
                return r;
            }
        }
        return -Infinity;
    };

    for (const c of creeps) {
        const want = st.intent.get(c.name);
        if (want === undefined) continue;
        const cur = /** @type {number} */ (matched.get(c.name));
        if (cur === want) continue;
        map.delete(cur);
        matched.delete(c.name);
        if (dfs(c, 0, new Set()) > 0) continue;
        assign(c, pack(c.pos.x, c.pos.y));
    }

    let shoved = 0;
    for (const c of creeps) {
        const p = /** @type {number} */ (matched.get(c.name));
        const x = p % 50;
        const y = (p - x) / 50;
        if (x === c.pos.x && y === c.pos.y) continue;
        // Creeps with an intent already called move(); only re-issue if the tile changed.
        if (st.intent.get(c.name) === p) continue;
        c.move(c.pos.getDirectionTo(x, y));
        shoved++;
    }
    return shoved;
}

/** Rooms with registered moves this tick. @returns {string[]} */
function rooms() {
    return Object.keys(tick());
}

module.exports = { register, working, pin, resolve, rooms };
