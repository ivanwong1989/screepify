// @ts-check
'use strict';

/**
 * Configuration (DESIGN §14).
 *
 * Effective config = DEFAULTS
 *                    ← Memory.config               (console overrides, all shards)
 *                    ← DEFAULTS.shards[shard]       (code defaults for this shard)
 *                    ← Memory.config.shards[shard]  (console overrides for this shard)
 *
 * Shard differences live here, never as `if (shard === ...)` in code (DESIGN §18.3).
 */

/**
 * @typedef {Object} ProcessOverride
 * @property {boolean} [enabled]
 * @property {number} [every]
 *
 * @typedef {Object} Config
 * @property {Record<string, ProcessOverride>} processes
 * @property {{enabled: boolean}} pixel
 * @property {{segment: number, history: number, topProcesses: number}} stats
 * @property {{quarantineAfter: number, quarantineTicks: number, errorLogInterval: number,
 *             lowBucketFloor: number, maxOwedTicks: number}} kernel
 * @property {Record<string, boolean>} debug
 * @property {string[]} allies           usernames never treated as hostile
 * @property {{enabled: boolean, rooms: string[]}} safeMode   rooms: [] = all owned rooms
 * @property {{enabled: boolean}} construction                automatic layout + sites
 * @property {{stockpileTargets: Record<string, number>, stockpileHysteresis: number}} policy
 * @property {{every: Record<string, number>}} missions   refresh interval per generator, in ticks
 *           (v1 missionThrottle; the planner itself runs every 2 ticks)
 *           room policy: storage energy target per RCL for STOCKPILE (sense.policy)
 * @property {Record<string, any>} shards
 */

/** @type {Config} */
const DEFAULTS = {
    processes: {},
    pixel: { enabled: true },
    stats: { segment: 90, history: 100, topProcesses: 10 },
    kernel: {
        quarantineAfter: 20,
        quarantineTicks: 500,
        errorLogInterval: 100,
        lowBucketFloor: 1000,
        maxOwedTicks: 50
    },
    debug: {},
    allies: [],
    safeMode: { enabled: true, rooms: [] },
    construction: { enabled: true },
    policy: {
        stockpileTargets: { 1: 0, 2: 0, 3: 20000, 4: 50000, 5: 100000, 6: 150000, 7: 250000, 8: 350000 },
        stockpileHysteresis: 0.10
    },
    missions: {
        every: {
            tower: 1, harvest: 21, fleet: 11, logistics: 7, repair: 25, upgrade: 11,
            build: 17, decongest: 31, idleUpgrade: 31, default: 31
        }
    },
    shards: {}
};

/** @param {any} v */
function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep-merges `src` into a copy of `base`. Arrays and scalars replace.
 * @param {any} base
 * @param {any} src
 * @returns {any}
 */
function merge(base, src) {
    if (!isPlainObject(src)) return src === undefined ? clone(base) : clone(src);
    const out = isPlainObject(base) ? clone(base) : {};
    for (const key of Object.keys(src)) {
        out[key] = isPlainObject(src[key]) && isPlainObject(out[key])
            ? merge(out[key], src[key])
            : clone(src[key]);
    }
    return out;
}

/** @param {any} v */
function clone(v) {
    return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

/** @type {Config|null} */
let current = null;

/**
 * Recomputes the effective config for this shard.
 * @returns {Config}
 */
function load() {
    const shard = (Game.shard && Game.shard.name) || 'sim';
    const overrides = (Memory.config && isPlainObject(Memory.config)) ? Memory.config : {};
    let cfg = merge(DEFAULTS, overrides);
    cfg = merge(cfg, (DEFAULTS.shards && DEFAULTS.shards[shard]) || {});
    cfg = merge(cfg, (overrides.shards && overrides.shards[shard]) || {});
    current = cfg;
    return cfg;
}

/** @returns {Config} */
function get() {
    return current || load();
}

/**
 * Sets an override in Memory.config by dotted path and reloads.
 * @param {string} path e.g. 'pixel.enabled' or 'processes.report.stats.enabled'
 * @param {any} value
 */
function set(path, value) {
    if (!Memory.config || !isPlainObject(Memory.config)) Memory.config = {};
    const keys = splitPath(path);
    let node = Memory.config;
    for (let i = 0; i < keys.length - 1; i++) {
        if (!isPlainObject(node[keys[i]])) node[keys[i]] = {};
        node = node[keys[i]];
    }
    node[keys[keys.length - 1]] = value;
    return load();
}

/**
 * Removes an override (falls back to defaults) and reloads.
 * @param {string} path
 */
function reset(path) {
    if (!Memory.config) return load();
    const keys = splitPath(path);
    let node = Memory.config;
    for (let i = 0; i < keys.length - 1; i++) {
        if (!isPlainObject(node[keys[i]])) return load();
        node = node[keys[i]];
    }
    delete node[keys[keys.length - 1]];
    return load();
}

/**
 * Splits a dotted path, but keeps process ids (which contain dots) intact:
 * 'processes.report.stats.enabled' → ['processes', 'report.stats', 'enabled'].
 * @param {string} path
 * @returns {string[]}
 */
function splitPath(path) {
    const parts = String(path).split('.');
    if (parts[0] === 'processes' && parts.length > 3) {
        return ['processes', parts.slice(1, -1).join('.'), parts[parts.length - 1]];
    }
    return parts;
}

module.exports = { DEFAULTS, load, get, set, reset, merge, splitPath };
