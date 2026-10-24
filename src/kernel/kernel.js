// @ts-check
'use strict';

const cache = require('../services/cache');
const log = require('../services/log');
const segments = require('../services/segments');
const config = require('../config');
const memory = require('./memory');
const context = require('./context');
const telemetry = require('./telemetry');

/**
 * The kernel (DESIGN §5): the only module that knows about the tick.
 *
 * Per tick: migrate Memory if needed → build ctx → for each phase, run the
 * processes that are due, allowed by tier and fit the CPU budget → one burst
 * job (between ACT and REPORT) → commit segments → fold telemetry.
 */

/** @typedef {import('../contracts/process').Process} Process */
/** @typedef {import('../contracts/process').Phase} Phase */

/** @type {Phase[]} */
const PHASES = ['SENSE', 'PLAN', 'ACT', 'REPORT'];
const TIERS = ['critical', 'normal', 'low', 'burst'];
const SCOPES = ['room', 'shard'];

/**
 * Soft CPU target for this tick from the bucket (DESIGN §5.2).
 * @param {number} limit
 * @param {number} bucket
 */
function softLimit(limit, bucket) {
    if (bucket < 1000) return limit * 0.8;
    if (bucket <= 6000) return limit * 0.95;
    return limit * 1.2;
}

/**
 * Small stable string hash, used to stagger cadences.
 * @param {string} str
 */
function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h);
}

/**
 * True when a process with cadence `every` is due this tick for `key`.
 * Different keys (rooms, processes) land on different ticks (DESIGN §5.3).
 * @param {number} every
 * @param {string} key
 * @param {number} time
 */
function isDue(every, key, time) {
    if (!(every > 1)) return true;
    return (time + hash(key)) % every === 0;
}

/**
 * @param {Process[]} processes
 */
function validate(processes) {
    const ids = new Set();
    for (const p of processes) {
        if (!p || typeof p.id !== 'string' || !p.id) throw new Error('process without id');
        if (ids.has(p.id)) throw new Error(`duplicate process id ${p.id}`);
        ids.add(p.id);
        if (!PHASES.includes(p.phase)) throw new Error(`${p.id}: bad phase ${p.phase}`);
        if (!SCOPES.includes(p.scope)) throw new Error(`${p.id}: bad scope ${p.scope}`);
        if (!TIERS.includes(p.tier)) throw new Error(`${p.id}: bad tier ${p.tier}`);
        if (typeof p.run !== 'function') throw new Error(`${p.id}: run() missing`);
        if (p.tier === 'burst') {
            if (typeof p.pending !== 'function') throw new Error(`${p.id}: burst needs pending()`);
            if (p.scope !== 'shard') throw new Error(`${p.id}: burst must be shard scope`);
        }
    }
}

/**
 * @typedef {{
 *   booted: boolean,
 *   owed: Map<string, number>,
 *   fails: Record<string, number>,
 *   quarantine: Record<string, number>,
 *   lastTick: {ran: number, skipped: number, burst: string|null}
 * }} KernelState
 */

/**
 * @param {Process[]} processes  the registry
 */
function createKernel(processes) {
    validate(processes);
    const ordered = processes.slice().sort((a, b) =>
        (PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase)) ||
        ((a.priority || 100) - (b.priority || 100)) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    /** @type {Record<string, Process[]>} */
    const byPhase = {};
    for (const phase of PHASES) {
        byPhase[phase] = ordered.filter(p => p.phase === phase && p.tier !== 'burst');
    }
    const bursts = ordered.filter(p => p.tier === 'burst');

    /** @returns {KernelState} */
    function state() {
        const s = cache.store('kernel');
        if (!s.owed) {
            s.booted = false;
            s.owed = new Map();
            s.fails = Object.create(null);
            s.quarantine = Object.create(null);
            s.lastTick = { ran: 0, skipped: 0, burst: null };
        }
        return /** @type {KernelState} */ (s);
    }

    /**
     * @param {Process} p
     * @param {import('../config').Config} cfg
     */
    function override(p, cfg) {
        return (cfg.processes && cfg.processes[p.id]) || {};
    }

    /**
     * @param {Process} p
     * @param {import('../config').Config} cfg
     * @param {number} time
     */
    function isActive(p, cfg, time) {
        return override(p, cfg).enabled !== false;
    }

    /**
     * Quarantine is per invocation key (process, or process@room), so one
     * failing room doesn't stop the process in the others.
     * @param {string} key
     * @param {number} time
     */
    function quarantined(key, time) {
        const until = state().quarantine[key];
        if (until === undefined) return false;
        if (time < until) return true;
        delete state().quarantine[key];
        return false;
    }

    /**
     * Runs one process invocation with fault isolation and CPU accounting.
     * @param {Process} p
     * @param {import('../contracts/ctx').TickContext} ctx
     * @param {import('../contracts/ctx').RoomCtx|undefined} room
     * @returns {number} CPU used
     */
    function invoke(p, ctx, room) {
        const s = state();
        const start = Game.cpu.getUsed();
        const key = room ? `${p.id}@${room.name}` : p.id;
        try {
            p.run(ctx, /** @type {any} */ (room));
            if (s.fails[key]) delete s.fails[key];
        } catch (e) {
            onError(p, ctx, room, e);
        }
        const used = Game.cpu.getUsed() - start;
        telemetry.record(p.id, room && room.name, used);
        return used;
    }

    /**
     * @param {Process} p
     * @param {import('../contracts/ctx').TickContext} ctx
     * @param {import('../contracts/ctx').RoomCtx|undefined} room
     * @param {any} e
     */
    function onError(p, ctx, room, e) {
        const s = state();
        const k = ctx.config.kernel;
        // Counted per process and room: a success in another room must not
        // reset a room that keeps failing.
        const where = room ? `${p.id}@${room.name}` : p.id;
        s.fails[where] = (s.fails[where] || 0) + 1;
        log.throttled(`err:${where}`, k.errorLogInterval, () =>
            log.error(`process ${where} threw (${s.fails[where]}x):`, (e && e.stack) || e));
        if (s.fails[where] >= k.quarantineAfter) {
            s.quarantine[where] = ctx.time + k.quarantineTicks;
            delete s.fails[where];
            log.error(`process ${where} quarantined until tick ${s.quarantine[where]}`);
        }
    }

    /** @param {import('../contracts/ctx').TickContext} ctx */
    function boot(ctx) {
        const s = state();
        for (const p of ordered) {
            if (typeof p.init !== 'function') continue;
            try {
                p.init(ctx);
            } catch (e) {
                log.error(`process ${p.id} init failed:`, (e && /** @type {any} */ (e).stack) || e);
            }
        }
        s.booted = true;
        log.info(`[kernel] booted ${ordered.length} processes on ${ctx.shard}`);
    }

    /**
     * @param {Phase} phase
     * @param {import('../contracts/ctx').TickContext} ctx
     * @returns {number} CPU used inside processes
     */
    function runPhase(phase, ctx) {
        const s = state();
        const cfg = ctx.config;
        /** @type {Array<{p: Process, room: import('../contracts/ctx').RoomCtx|undefined, key: string, owed: boolean, forced: boolean}>} */
        const entries = [];

        // Phase priority order, always: a process that supplies this tick's
        // data runs before the ones that read it, owed or not.
        for (const p of byPhase[phase]) {
            if (!isActive(p, cfg, ctx.time)) continue;
            const every = override(p, cfg).every || p.every || 1;
            if (p.scope === 'shard') {
                const key = p.id;
                if (quarantined(key, ctx.time)) continue;
                const owed = s.owed.has(key);
                if (owed || isDue(every, key, ctx.time)) entries.push({ p, room: undefined, key, owed, forced: false });
            } else {
                for (const room of ctx.roomList) {
                    if (p.kinds && p.kinds.indexOf(room.kind) === -1) continue;
                    const key = `${p.id}@${room.name}`;
                    if (quarantined(key, ctx.time)) continue;
                    const owed = s.owed.has(key);
                    const forced = !!(p.force && p.force(ctx, room));
                    if (owed || forced || isDue(every, key, ctx.time)) entries.push({ p, room, key, owed, forced });
                }
            }
        }

        // Owed work keeps precedence on the budget instead of on the order:
        // a non-owed entry only runs if the owed ones still to come fit too.
        // (Low-tier work that the bucket floor blocks reserves nothing.)
        const lowFloor = ctx.cpu.bucket < cfg.kernel.lowBucketFloor;
        const reserves = (/** @type {{p: Process, owed: boolean}} */ e) =>
            e.owed && e.p.tier !== 'critical' && !(e.p.tier === 'low' && lowFloor);
        let owedAhead = 0;
        for (const e of entries) if (reserves(e)) owedAhead += telemetry.estimate(e.p.id);

        let used = 0;
        for (const { p, room, key, owed, forced } of entries) {
            const est = telemetry.estimate(p.id);
            if (reserves({ p, owed })) owedAhead -= est;
            // Critical and forced runs (e.g. plan.missions after a VM reset,
            // which everything after it depends on) are never skipped.
            if (p.tier !== 'critical' && !forced) {
                const since = s.owed.get(key);
                // Never starve: after maxOwedTicks of skipping, run regardless of budget.
                const starving = since !== undefined && ctx.time - since >= cfg.kernel.maxOwedTicks;
                const lowBlocked = p.tier === 'low' && ctx.cpu.bucket < cfg.kernel.lowBucketFloor;
                const reserve = owed ? 0 : owedAhead;
                const over = Game.cpu.getUsed() + est + reserve > ctx.kernel.softLimit;
                if (!starving && (lowBlocked || over)) {
                    if (since === undefined) s.owed.set(key, ctx.time);
                    s.lastTick.skipped++;
                    telemetry.skipped(p.id);
                    continue;
                }
            }
            s.owed.delete(key);
            used += invoke(p, ctx, room);
            s.lastTick.ran++;
        }
        return used;
    }

    /**
     * Picks and runs at most one burst job (DESIGN §5.2). Sets ctx.kernel.burstPending.
     * @param {import('../contracts/ctx').TickContext} ctx
     * @returns {number} CPU used
     */
    function runBurst(ctx) {
        /** @type {Process|null} */
        let chosen = null;
        for (const p of bursts) {
            if (!isActive(p, ctx.config, ctx.time)) continue;
            let pending = false;
            try {
                pending = !!(p.pending && p.pending(ctx));
            } catch (e) {
                onError(p, ctx, undefined, e);
            }
            if (!pending) continue;
            ctx.kernel.burstPending = true;
            if (!chosen && ctx.cpu.bucket >= (p.bucketNeeded || 0)) chosen = p;
        }
        if (!chosen) return 0;
        state().lastTick.burst = chosen.id;
        return invoke(chosen, ctx, undefined);
    }

    /**
     * Runs one game tick.
     * @returns {import('../contracts/ctx').TickContext}
     */
    function tick() {
        if (!memory.isCurrent()) memory.migrate();
        const cfg = config.get();
        log.setCategories(cfg.debug);
        const ctx = context.build(cfg);
        ctx.kernel.softLimit = softLimit(ctx.cpu.limit, ctx.cpu.bucket);

        const s = state();
        s.lastTick = { ran: 0, skipped: 0, burst: null };
        if (!s.booted) boot(ctx);

        let processCpu = 0;
        for (const phase of PHASES) {
            if (phase === 'REPORT') processCpu += runBurst(ctx);
            processCpu += runPhase(phase, ctx);
        }

        try {
            segments.commit();
        } catch (e) {
            log.throttled('segments.commit', 100, () => log.error('segments.commit failed:', e));
        }
        telemetry.endTick(Game.cpu.getUsed(), processCpu);
        return ctx;
    }

    return { tick, state, processes: ordered };
}

module.exports = { createKernel, softLimit, isDue, hash, PHASES };
