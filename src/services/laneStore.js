// @ts-check
'use strict';

const cache = require('./cache');
const lanes = require('./lanes');
const roomData = require('./roomData');

/**
 * Saved core lanes (Memory.rooms[n].ln) and their per-tick decoded form.
 *
 * Memory: {v, t, sig, h, src, loop, p: "packed,packed,...", cov, w}
 * Decoded (heap, rebuilt when the saved lane or the room's targets change):
 *   path, index (packed → lane index), loop, head, sourceId,
 *   stops (lane index → target ids next to it), covered (all stop target ids)
 */

const VERSION = 1;

/**
 * @typedef {Object} SavedLane
 * @property {number} v
 * @property {number} t      tick built
 * @property {string} sig    room signature it was built for
 * @property {number} h      head (packed)
 * @property {string} src    structure loaded from at the head (storage)
 * @property {number} loop   1 = loop
 * @property {string} p      packed tiles, comma separated
 * @property {number} cov    targets covered when built
 *
 * @typedef {Object} Lane
 * @property {string} room
 * @property {number[]} path
 * @property {Map<number, number>} index
 * @property {boolean} loop
 * @property {number} head
 * @property {string} sourceId
 * @property {Record<number, string[]>} stops
 * @property {Set<string>} covered
 */

/**
 * What a lane depends on; a change means rebuild (v1 buildInputsChanged).
 * @param {Room} room
 */
function signature(room) {
    const flag = roomData.flags(room).find(f => f.name.indexOf('CORE_END') === 0);
    const tgts = lanes.targets(room);
    let sum = 0;
    for (const t of tgts) sum = (sum + t.y * 50 + t.x) % 1000003;
    return [
        tgts.length, sum,
        roomData.byType(room, STRUCTURE_ROAD).length,
        roomData.sites(room).length,
        room.storage ? room.storage.id : '-',
        room.terminal ? room.terminal.id : '-',
        roomData.myByType(room, STRUCTURE_LINK).length,
        flag ? `${flag.pos.x},${flag.pos.y}` : '-'
    ].join('|');
}

/** @param {string} roomName @returns {SavedLane|undefined} */
function saved(roomName) {
    const mem = /** @type {any} */ (Memory.rooms[roomName]);
    const ln = mem && mem.ln;
    return ln && ln.v === VERSION ? ln : undefined;
}

/**
 * @param {string} roomName
 * @param {{head: number, sourceId: string, best: import('./lanes').BuiltLane|null}} job
 * @param {string} sig
 */
function save(roomName, job, sig) {
    const mem = /** @type {any} */ (Memory.rooms[roomName] || (Memory.rooms[roomName] = {}));
    const lane = job.best;
    if (!lane) {
        // Remember the failed attempt so it isn't retried every tick.
        mem.ln = { v: VERSION, t: Game.time, sig, h: job.head, src: job.sourceId, loop: 0, p: '', cov: 0 };
        return;
    }
    mem.ln = {
        v: VERSION, t: Game.time, sig, h: job.head, src: job.sourceId,
        loop: lane.loop ? 1 : 0, p: lane.path.join(','), cov: lane.covered
    };
}

/** @param {string} roomName */
function clear(roomName) {
    const mem = /** @type {any} */ (Memory.rooms[roomName]);
    if (mem) delete mem.ln;
}

/**
 * The room's lane, decoded, or null when there is none.
 * @param {Room} room
 * @returns {Lane|null}
 */
function get(room) {
    const ln = saved(room.name);
    if (!ln || !ln.p) return null;
    return cache.perTick(`lane:${room.name}`, () => {
        const store = cache.store('lanes.decoded');
        const tgts = lanes.targets(room);
        let sum = 0;
        for (const t of tgts) sum = (sum + t.y * 50 + t.x) % 1000003;
        const tsig = `${tgts.length}:${sum}`;
        const hit = store[room.name];
        if (hit && hit.t === ln.t && hit.tsig === tsig) return hit.lane;
        const path = ln.p.split(',').map(Number);
        /** @type {Map<number, number>} */
        const index = new Map();
        path.forEach((p, i) => { if (!index.has(p)) index.set(p, i); });
        const stops = lanes.stops(path, tgts);
        /** @type {Set<string>} */
        const covered = new Set();
        for (const k in stops) for (const id of stops[k]) covered.add(id);
        /** @type {Lane} */
        const lane = { room: room.name, path, index, loop: ln.loop === 1, head: ln.h, sourceId: ln.src, stops, covered };
        store[room.name] = { t: ln.t, tsig, lane };
        return lane;
    });
}

module.exports = { signature, saved, save, clear, get, VERSION };
