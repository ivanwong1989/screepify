// @ts-check
'use strict';

const cache = require('./cache');

/**
 * Memory segment broker.
 *
 * - Segments are 0–99, at most 10 active at once, 100 KB each.
 * - Data requested with `setActiveSegments` is readable on the NEXT tick.
 * - The documented write pattern activates a segment before writing it, so
 *   writes to an inactive segment are queued, the segment is requested, and the
 *   write is flushed on the first tick it is active.
 *
 * Call `commit()` once at the end of every tick (the kernel does this).
 */

const MAX_ACTIVE = 10;
const MAX_SEGMENT_SIZE = 100 * 1024;

function state() {
    const s = cache.store('segments');
    if (!s.wanted) s.wanted = new Set();      // persistent wishes (e.g. stats segment)
    if (!s.pending) s.pending = Object.create(null); // id -> string awaiting activation
    return /** @type {{wanted: Set<number>, pending: Record<string, string>}} */ (s);
}

/**
 * Keep a segment active every tick.
 * @param {number} id
 */
function keepActive(id) {
    state().wanted.add(id);
}

/**
 * @param {number} id
 * @returns {string|undefined} contents, if the segment is active this tick
 */
function read(id) {
    return RawMemory.segments[id];
}

/**
 * Writes a segment now if it is active, otherwise queues it.
 * @param {number} id
 * @param {string} data
 * @returns {'written'|'queued'|'too_large'}
 */
function write(id, data) {
    if (data.length > MAX_SEGMENT_SIZE) return 'too_large';
    const s = state();
    if (RawMemory.segments[id] !== undefined) {
        RawMemory.segments[id] = data;
        delete s.pending[id];
        return 'written';
    }
    s.pending[id] = data;
    return 'queued';
}

/** Flushes queued writes and requests next tick's active set. */
function commit() {
    const s = state();
    const ids = new Set(s.wanted);
    for (const key in s.pending) {
        const id = Number(key);
        if (RawMemory.segments[id] !== undefined) {
            RawMemory.segments[id] = s.pending[key];
            delete s.pending[key];
        } else {
            ids.add(id);
        }
    }
    const list = Array.from(ids).slice(0, MAX_ACTIVE);
    RawMemory.setActiveSegments(list);
    return list;
}

module.exports = { keepActive, read, write, commit, MAX_ACTIVE, MAX_SEGMENT_SIZE };
