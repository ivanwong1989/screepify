// @ts-check
'use strict';

/**
 * Heap cache: named stores that live on `global` until the VM resets.
 *
 * Everything stored here must be rebuildable from `Game` + `Memory` (DESIGN §7).
 * Modules never invent their own `global._x`; they ask for a named store instead.
 */

const HEAP_KEY = '__v2heap';
const HEAP_VERSION = 1;

/**
 * @typedef {Object} HeapRoot
 * @property {number} version
 * @property {number} created  Game.time when the heap was (re)built
 * @property {Record<string, {data: Record<string, any>, expires: number|null}>} stores
 * @property {{time: number, values: Record<string, any>}} tick
 */

/** @returns {HeapRoot} */
function root() {
    const g = /** @type {any} */ (global);
    let h = g[HEAP_KEY];
    if (!h || h.version !== HEAP_VERSION) {
        h = {
            version: HEAP_VERSION,
            created: Game.time,
            stores: Object.create(null),
            tick: { time: -1, values: Object.create(null) }
        };
        g[HEAP_KEY] = h;
    }
    return h;
}

/**
 * Returns a named store. With `ttl`, the store is emptied every `ttl` ticks.
 * @param {string} name
 * @param {{ttl?: number|null}} [opts]
 * @returns {Record<string, any>}
 */
function store(name, opts) {
    if (!name) throw new Error('cache.store(name) requires a name');
    const h = root();
    const ttl = opts && opts.ttl ? opts.ttl : null;
    let s = h.stores[name];
    if (!s || (s.expires !== null && Game.time >= s.expires)) {
        s = { data: Object.create(null), expires: ttl ? Game.time + ttl : null };
        h.stores[name] = s;
    }
    return s.data;
}

/**
 * Drops a named store (e.g. room GC).
 * @param {string} name
 */
function drop(name) {
    delete root().stores[name];
}

/**
 * Memoises `compute()` for the rest of the current tick.
 * @template T
 * @param {string} key
 * @param {() => T} compute
 * @returns {T}
 */
function perTick(key, compute) {
    const h = root();
    if (h.tick.time !== Game.time) {
        h.tick = { time: Game.time, values: Object.create(null) };
    }
    if (!(key in h.tick.values)) h.tick.values[key] = compute();
    return h.tick.values[key];
}

/** Game.time when the current heap was built (i.e. last VM reset). */
function heapAge() {
    return Game.time - root().created;
}

module.exports = { store, drop, perTick, heapAge };
