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
 *   owed: Set<string>,
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
            s.owed = new Set();
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
        if (override(p, cfg).enabled === false) return false;
        const until = state().quarantine[p.id];
        if (until !== undefined) {
            if (time < until) return false;
            delete state().quarantine[p.id];
        }
        return true;
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
        try {
            p.run(ctx, /** @type {any} */ (room));
            s.fails[p.id] = 0;
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
        s.fails[p.id] = (s.fails[p.id] || 0) + 1;
        const where = room ? `${p.id}@${room.name}` : p.id;
        log.throttled(`err:${where}`, k.errorLogInterval, () =>
            log.error(`process ${where} threw (${s.fails[p.id]}x):`, (e && e.stack) || e));
        if (s.fails[p.id] >= k.quarantineAfter) {
            s.quarantine[p.id] = ctx.time + k.quarantineTicks;
            s.fails[p.id] = 0;
            log.error(`process ${p.id} quarantined until tick ${s.quarantine[p.id]}`);
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
        /** @type {Array<{p: Process, room: import('../contracts/ctx').RoomCtx|undefined, key: string}>} */
        const owedFirst = [];
        /** @type {typeof owedFirst} */
        const rest = [];

        for (const p of byPhase[phase]) {
            if (!isActive(p, cfg, ctx.time)) continue;
            const every = override(p, cfg).every || p.every || 1;
            if (p.scope === 'shard') {
                const key = p.id;
                if (s.owed.has(key)) owedFirst.push({ p, room: undefined, key });
                else if (isDue(every, key, ctx.time)) rest.push({ p, room: undefined, key });
            } else {
                for (const room of ctx.roomList) {
                    const key = `${p.id}@${room.name}`;
                    if (s.owed.has(key)) owedFirst.push({ p, room, key });
                    else if (isDue(every, key, ctx.time)) rest.push({ p, room, key });
                }
            }
        }

        let used = 0;
        const entries = owedFirst.length ? owedFirst.concat(rest) : rest;
        for (const { p, room, key } of entries) {
            if (p.tier !== 'critical') {
                const lowBlocked = p.tier === 'low' && ctx.cpu.bucket < cfg.kernel.lowBucketFloor;
                const over = Game.cpu.getUsed() + telemetry.estimate(p.id) > ctx.kernel.softLimit;
                if (lowBlocked || over) {
                    s.owed.add(key);
                    s.lastTick.skipped++;
                    telemetry.skipped();
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
