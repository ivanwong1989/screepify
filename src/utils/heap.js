// utils/heap.js
'use strict';

/**
 * Heap Manager (volatile, auto-rebuilt after VM reset)
 *
 * - Backed by `global.__heap` (lost on VM reset)
 * - Provides named stores so modules don't invent their own globals
 * - Supports versioned invalidation and optional TTL resets per store
 */

const HEAP_VERSION = 1;

function ensureHeap() {
    const h = global.__heap;
    if (!h || h.version !== HEAP_VERSION) {
        global.__heap = {
            version: HEAP_VERSION,
            created: Game.time,
            stores: Object.create(null),
            meta: Object.create(null)
        };
    }
    return global.__heap;
}

function getStore(name, opts = undefined) {
    if (!name) throw new Error('heap.getStore(name) requires a non-empty name');

    const heap = ensureHeap();
    const stores = heap.stores;
    const meta = heap.meta;

    if (!stores[name]) {
        stores[name] = Object.create(null);
        meta[name] = {
            created: Game.time,
            lastReset: Game.time,
            hits: 0,
            ttl: (opts && Number.isFinite(opts.ttl)) ? opts.ttl : null
        };
    }

    const m = meta[name];
    m.hits++;

    // Optional TTL-based reset
    if (m.ttl != null && (Game.time - m.lastReset) >= m.ttl) {
        stores[name] = Object.create(null);
        m.lastReset = Game.time;
    }

    return stores[name];
}

function resetStore(name) {
    const heap = ensureHeap();
    heap.stores[name] = Object.create(null);
    heap.meta[name] = heap.meta[name] || Object.create(null);
    heap.meta[name].lastReset = Game.time;
    return true;
}

function stats() {
    const heap = ensureHeap();
    // lightweight snapshot for debugging
    const out = {};
    for (const k in heap.meta) {
        const m = heap.meta[k];
        out[k] = { hits: m.hits, created: m.created, lastReset: m.lastReset, ttl: m.ttl };
    }
    return out;
}

module.exports = { ensureHeap, getStore, resetStore, stats };
