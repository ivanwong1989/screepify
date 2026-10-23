// @ts-check
'use strict';

const cache = require('./cache');
const log = require('./log');

/**
 * Circuit breaker against ping-pong (docs/v2/LOGISTICS.md §2.5).
 *
 * Every committed job is recorded per (store, resource) as "out" at its source
 * and "in" at its destination (the buffer is not tracked). A store that keeps
 * switching between giving and receiving the same resource, at least LIMIT
 * times within WINDOW ticks, is taken out of the request list for BLOCK
 * ticks and logged as an error. The model should never get there; this only
 * makes sure a bug can't keep haulers busy shuttling while the colony starves.
 *
 * Legit outside changes (terminal sends, market) flip a store at most every
 * ~50 ticks, far below the limit; a real loop flips every few ticks.
 */

const WINDOW = 100;
const LIMIT = 6;
const BLOCK = 1500;

/** @typedef {{dir: string, flips: number[], until?: number}} Track */

/** @returns {Record<string, Track>} */
function store() {
    return cache.store('logistics.flips');
}

/**
 * @param {string} roomName
 * @param {{r: string, f: string|null, d: string}} job
 * @param {string|null} bufferId
 */
function record(roomName, job, bufferId) {
    const s = store();
    for (const [id, dir] of [[job.f, 'out'], [job.d, 'in']]) {
        if (!id || id === bufferId) continue;
        const key = `${roomName}:${id}:${job.r}`;
        const t = s[key] || (s[key] = { dir, flips: [] });
        if (t.dir !== dir) {
            t.flips.push(Game.time);
            t.dir = dir;
        }
        while (t.flips.length && t.flips[0] <= Game.time - WINDOW) t.flips.shift();
        if (t.flips.length >= LIMIT && !(t.until && t.until > Game.time)) {
            t.until = Game.time + BLOCK;
            t.flips = [];
            log.error(`[logistics] ${roomName}: ${job.r} at ${id} flipped in/out ${LIMIT}× in ${WINDOW} ticks; left out for ${BLOCK} ticks`);
        }
    }
}

/**
 * Keys `${id}:${res}` currently blocked in a room.
 * @param {string} roomName
 * @returns {Set<string>}
 */
function blocked(roomName) {
    /** @type {Set<string>} */
    const out = new Set();
    const prefix = `${roomName}:`;
    const s = store();
    for (const key of Object.keys(s)) {
        if (!key.startsWith(prefix)) continue;
        const t = s[key];
        if (t.until && t.until > Game.time) out.add(key.slice(prefix.length));
        else if (!t.flips.length && t.until) delete s[key];
    }
    return out;
}

module.exports = { record, blocked, WINDOW, LIMIT, BLOCK };
