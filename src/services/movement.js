// @ts-check
'use strict';

const cache = require('./cache');
const roomData = require('./roomData');
const { isExit } = require('./pos');
const traffic = require('./traffic');
const miningStations = require('./miningStations');

/**
 * Movement library (DESIGN §11.1), built on Traveler's ideas:
 * - path once, store it as a direction string on heap, then one move() per tick
 * - ignore creeps when pathing; only when stuck, repath once treating creeps as obstacles
 * - cost matrices cached per room, rebuilt when structures/sites change
 * - route between rooms with Game.map.findRoute first, then PathFinder inside the route
 *
 * Moves go through services/traffic, which can swap or shove creeps in the way.
 */

const STUCK_TICKS = 2;
const MATRIX_TTL = 1000;
const PLAIN_COST = 2;
const SWAMP_COST = 10;
const ROAD_COST = 1;

/**
 * @typedef {{dk: string, path: string, lx: number, ly: number, stuck: number}} TravelState
 */

/** @returns {Record<string, TravelState>} */
function travelStore() {
    return cache.store('move.travel');
}

/** @param {Structure|ConstructionSite} s */
function isObstacle(s) {
    const t = s.structureType;
    if (t === STRUCTURE_ROAD || t === STRUCTURE_CONTAINER) return false;
    if (t === STRUCTURE_RAMPART) {
        const r = /** @type {any} */ (s);
        return !(r.my || r.isPublic);
    }
    return OBSTACLE_OBJECT_TYPES.indexOf(/** @type {any} */ (t)) !== -1;
}

/**
 * Structure cost matrix for a visible room, cached on heap.
 * @param {Room} room
 * @returns {CostMatrix}
 */
function structureMatrix(room) {
    const store = cache.store('move.matrix');
    const structs = roomData.structures(room);
    const sites = roomData.sites(room);
    const sig = `${structs.length}:${sites.length}`;
    const entry = store[room.name];
    if (entry && entry.sig === sig && Game.time - entry.t < MATRIX_TTL) return entry.m;

    const m = new PathFinder.CostMatrix();
    for (const s of structs) {
        if (s.structureType === STRUCTURE_ROAD) {
            if (m.get(s.pos.x, s.pos.y) === 0) m.set(s.pos.x, s.pos.y, ROAD_COST);
        } else if (isObstacle(s)) {
            m.set(s.pos.x, s.pos.y, 0xff);
        }
    }
    for (const site of sites) {
        if (isObstacle(site)) m.set(site.pos.x, site.pos.y, 0xff);
    }
    store[room.name] = { sig, t: Game.time, m };
    return m;
}

/**
 * Structure matrix plus creeps as obstacles (used only after getting stuck).
 * @param {Room} room
 */
function creepMatrix(room) {
    const m = structureMatrix(room).clone();
    for (const c of room.find(FIND_CREEPS)) m.set(c.pos.x, c.pos.y, 0xff);
    for (const c of room.find(FIND_POWER_CREEPS)) m.set(c.pos.x, c.pos.y, 0xff);
    return m;
}

/**
 * Rooms the path may use (route-first for multi-room trips).
 * @param {string} from
 * @param {string} to
 * @returns {Set<string>|null} null = no restriction (same room)
 */
function allowedRooms(from, to) {
    if (from === to) return null;
    const route = Game.map.findRoute(from, to);
    if (route === ERR_NO_PATH || !Array.isArray(route)) return null;
    const rooms = new Set([from]);
    for (const step of route) rooms.add(step.room);
    return rooms;
}

/**
 * Serializes a PathFinder path as direction digits, skipping room changes.
 * @param {RoomPosition} start
 * @param {RoomPosition[]} path
 */
function serialize(start, path) {
    let out = '';
    let last = start;
    for (const p of path) {
        if (p.roomName === last.roomName) out += last.getDirectionTo(p);
        last = p;
    }
    return out;
}

/**
 * @param {RoomPosition} origin
 * @param {RoomPosition} dest
 * @param {number} range
 * @param {boolean} withCreeps
 * @returns {string}
 */
function findPath(origin, dest, range, withCreeps) {
    const allowed = allowedRooms(origin.roomName, dest.roomName);
    const ret = PathFinder.search(origin, { pos: dest, range }, {
        plainCost: PLAIN_COST,
        swampCost: SWAMP_COST,
        maxOps: allowed ? 20000 : 4000,
        roomCallback(roomName) {
            if (allowed && !allowed.has(roomName)) return false;
            const room = Game.rooms[roomName];
            if (!room) return undefined;
            const base = withCreeps && roomName === origin.roomName ? creepMatrix(room) : structureMatrix(room);
                const reserved = miningStations.reserved(roomName);
                const keys = Object.keys(reserved);
                if (!keys.length) return base;
                const matrix = base.clone();
                for (const key of keys) {
                    const parts = key.split(':');
                    const x = Number(parts[0]), y = Number(parts[1]);
                    if ((roomName === origin.roomName && origin.x === x && origin.y === y) ||
                        (roomName === dest.roomName && dest.x === x && dest.y === y)) continue;
                    matrix.set(x, y, 255);
                }
                return matrix;
        }
    });
    return serialize(origin, ret.path);
}

/**
 * @param {RoomPosition} pos
 * @param {RoomPosition} dest
 * @param {number} range
 */
function arrived(pos, dest, range) {
    if (pos.roomName !== dest.roomName) return false;
    // On an exit tile the game moves us to the next room at end of tick.
    if (isExit(pos) && range > 0) {
        if (dest.x !== pos.x || dest.y !== pos.y) return false;
    }
    return pos.inRangeTo(dest, range);
}

/**
 * Moves a creep toward a target. Call at most once per creep per tick.
 * @param {Creep} creep
 * @param {RoomPosition|{pos: RoomPosition}} target
 * @param {{range?: number}} [opts]
 * @returns {ScreepsReturnCode}
 */
function to(creep, target, opts) {
    const dest = /** @type {RoomPosition} */ ('pos' in target ? target.pos : target);
    const range = opts && Number.isFinite(opts.range) ? /** @type {number} */ (opts.range) : 1;
    const store = travelStore();

    if (arrived(creep.pos, dest, range)) {
        delete store[creep.name];
        return OK;
    }
    if (creep.fatigue > 0) return ERR_TIRED;

    const dk = `${dest.x}:${dest.y}:${dest.roomName}:${range}`;
    let st = store[creep.name];
    let fresh = false;
    if (!st || st.dk !== dk) {
        st = store[creep.name] = { dk, path: '', lx: -1, ly: -1, stuck: 0 };
        fresh = true;
    }

    // Did last tick's move work? (same coord, or bounced between exits = stuck)
    if (!fresh) {
        const same = creep.pos.x === st.lx && creep.pos.y === st.ly;
        const bounced = isExit(creep.pos) && (st.lx === 0 || st.ly === 0 || st.lx === 49 || st.ly === 49);
        if (same || bounced) st.stuck++;
        else if (onPath(creep.pos, st)) {
            st.stuck = 0;
            st.path = st.path.substr(1);
        } else {
            // Moved somewhere else (shoved by traffic): the path no longer starts here.
            st.stuck = 0;
            st.path = '';
        }
    }

    if (!st.path || st.stuck >= STUCK_TICKS) {
        st.path = findPath(creep.pos, dest, range, st.stuck >= STUCK_TICKS);
        st.stuck = 0;
    }
    st.lx = creep.pos.x;
    st.ly = creep.pos.y;
    if (!st.path) {
        delete store[creep.name];
        return ERR_NO_PATH;
    }
    const dir = /** @type {DirectionConstant} */ (Number(st.path[0]));
    return traffic.register(creep, dir);
}

const STEP = [null, [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

/**
 * True when `pos` is where last tick's first path step leads (room changes count).
 * @param {RoomPosition} pos
 * @param {TravelState} st
 */
function onPath(pos, st) {
    const d = STEP[Number(st.path[0])];
    if (!d) return true;
    const x = st.lx + d[0];
    const y = st.ly + d[1];
    // Stepping onto an exit tile moves the creep to the next room's edge.
    if (x <= 0 || x >= 49 || y <= 0 || y >= 49) return true;
    return pos.x === x && pos.y === y;
}

/** Forgets a creep's cached path. @param {Creep|string} creep */
function forget(creep) {
    delete travelStore()[typeof creep === 'string' ? creep : creep.name];
}

/** Drops cached matrices for a room (e.g. after placing sites). @param {string} roomName */
function invalidateRoom(roomName) {
    delete cache.store('move.matrix')[roomName];
}

module.exports = { to, forget, invalidateRoom, serialize, structureMatrix, arrived };
