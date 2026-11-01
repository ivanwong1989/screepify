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
 * @property {{enabled: boolean, maxSites: number, rooms: string[]}} laneFit
 *           spawns/towers/extensions next to the core lane (plan.laneFit, services/laneFit);
 *           maxSites = open sites of those types at once; rooms: [] = all owned rooms
 * @property {{stockpileTargets: Record<string, number>, stockpileHysteresis: number}} policy
 * @property {{enabled: boolean}} traffic       swap/shove creeps in the way (act.traffic)
 * @property {{enabled: boolean, mining: boolean, cpuPerTick: number, rebuildEvery: number, checkEvery: number}} lanes
 *           core lane search (plan.lanes) and the lane hauler (missions/coreLane);
 *           `mining` switches mining lanes (missions/miningLane) on or off
 * @property {{enabled: boolean, maxStock: number, minStorageFree: number}} minerals
 *           mineral mining (missions/mineral): stops at maxStock of that mineral
 *           in storage + terminal, or when storage has less than minStorageFree space
 * @property {import('./services/labs').LabConfig} labs
 *           lab reactions and boost stock (services/labs, plan.labs, act.labs);
 *           reaction 'auto' or a product ('KO'); boosts: {resource: labId}
 * @property {import('./services/market').MarketConfig} market
 *           auto market (act.market, docs/v2/MARKET.md): sell[resource] = {mode, keep, batch?, minPrice?}
 * @property {import('./services/terminal').TerminalConfig} terminal
 *           terminal stock targets (lane hauler, services/terminal) and energy
 *           balancing between rooms (act.terminal)
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
    laneFit: { enabled: false, maxSites: 2, rooms: [] },
    policy: {
        stockpileTargets: { 1: 0, 2: 0, 3: 20000, 4: 50000, 5: 100000, 6: 150000, 7: 250000, 8: 350000 },
        stockpileHysteresis: 0.10
    },
    traffic: { enabled: true },
    lanes: { enabled: true, mining: true, cpuPerTick: 10, rebuildEvery: 5000, checkEvery: 50 },
    minerals: { enabled: true, maxStock: 100000, minStorageFree: 50000 },
    market: {
        enabled: true,
        energyExport: { enabled: true, start: 450000, stop: 400000, reserve: 300000, terminalTarget: 50000, batch: 5000 },
        sell: {
            // Own sell orders: the buyer pays the transfer energy. Deals made
            // by us pay it, and with every buyer 40-80 rooms away and energy
            // at ~17 credits that left 5 credits (O) or less per unit
            // (docs/v2/MARKET.md).
            KO: { mode: 'order', keep: 2000 },
            ZK: { mode: 'deal', keep: 0, batch: 1000 },
            O: { mode: 'order', keep: 100000 },
            K: { mode: 'order', keep: 100000 }
        },
        // Off until the live prices have been reviewed (market.show()).
        floorFactor: 0.9, energyValue: 'auto', historyDays: 3,
        // Trade reference: median of daily averages over longDays; the recent
        // average counts only above longShare × median; < minTrades: no price.
        longDays: 14, longShare: 0.85, minTrades: 50,
        // Order book: listings outside [bandLow, bandHigh] × reference are
        // spam, under minListing are bait; the floor falls ≤ maxDropPerDay.
        bandLow: 0.5, bandHigh: 2, minListing: 1000, maxDropPerDay: 0.05,
        // Labs only make a product worth productMargin more than its reagents.
        productMargin: 0.05,
        minTerminalEnergy: 10000, terminalStock: 10000, orderSize: 5000, orderRefresh: 500,
        // Buying (act.marketBuy): off until reviewed. Never below creditReserve,
        // at most dailyCap credits a day, never above min(maxPrice, 1.1 × reference).
        buy: {
            enabled: true, creditReserve: 270000000, dailyCap: 30000, ceilingFactor: 1.1, maxRisePerDay: 0.05,
            stock: {}, maxPrice: {}, emergencyEnergy: 20000, energyBatch: 20000,
            complement: { enabled: true, margin: 0.10, anchorMin: 20000 }
        }
    },
    labs: {
        enabled: true, reaction: 'auto', inputTarget: 2000, outputMax: 1500, boostTarget: 1000,
        minReagent: 10000, keepReagent: 2000, productCap: 20000, boosts: {}, rooms: {},
        production: { margin: 0.20, minBatch: 1000, batch: 5000, stock: {} }
    },
    terminal: {
        energy: 20000,
        energyMargin: 2000,
        stock: {},
        flushUntargeted: false,
        rooms: {},
        balance: { enabled: true, batch: 10000 }
    },
    missions: {
        every: {
            tower: 1, harvest: 21, fleet: 11, logistics: 7, repair: 25, fortify: 25, mineral: 31, labHaul: 11, upgrade: 11,
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
