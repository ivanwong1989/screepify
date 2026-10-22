// @ts-check
'use strict';

const cache = require('../services/cache');

/**
 * Built-in CPU telemetry (DESIGN §5.5, §18.2).
 *
 * Two averages per process:
 * - runAvg:  EMA of the CPU of one run. The kernel's budget check uses it.
 * - tickAvg: EMA of the CPU per tick, including ticks it didn't run. This is its
 *            real share of the budget, used for reports.
 * Rooms get a tickAvg too, so the cost of one room is known before claiming another.
 */

const ALPHA = 0.1;

/**
 * @typedef {{runAvg: number, tickAvg: number, runs: number, max: number, last: number}} ProcStat
 * @typedef {{
 *   procs: Record<string, ProcStat>,
 *   rooms: Record<string, number>,
 *   tick: {cpuAvg: number, kernelAvg: number, skippedAvg: number, ticks: number, lastCpu: number},
 *   acc: {procs: Record<string, number>, rooms: Record<string, number>, skipped: number}
 * }} TelemetryState
 */

/** @returns {TelemetryState} */
function state() {
    const s = cache.store('telemetry');
    if (!s.procs) {
        s.procs = Object.create(null);
        s.rooms = Object.create(null);
        s.tick = { cpuAvg: 0, kernelAvg: 0, skippedAvg: 0, ticks: 0, lastCpu: 0 };
        s.acc = { procs: Object.create(null), rooms: Object.create(null), skipped: 0 };
    }
    return /** @type {TelemetryState} */ (s);
}

/**
 * @param {number} prev
 * @param {number} value
 * @param {boolean} first
 */
function ema(prev, value, first) {
    return first ? value : prev + ALPHA * (value - prev);
}

/**
 * Records one run of a process.
 * @param {string} id
 * @param {string|undefined} roomName
 * @param {number} cpu
 */
function record(id, roomName, cpu) {
    const s = state();
    let p = s.procs[id];
    if (!p) p = s.procs[id] = { runAvg: 0, tickAvg: 0, runs: 0, max: 0, last: 0 };
    p.runAvg = ema(p.runAvg, cpu, p.runs === 0);
    p.runs++;
    p.last = cpu;
    if (cpu > p.max) p.max = cpu;
    s.acc.procs[id] = (s.acc.procs[id] || 0) + cpu;
    if (roomName) s.acc.rooms[roomName] = (s.acc.rooms[roomName] || 0) + cpu;
}

/** Counts a process run skipped for budget (for the report). */
function skipped() {
    state().acc.skipped++;
}

/**
 * Expected CPU of one run of `id` (0 if never measured).
 * @param {string} id
 */
function estimate(id) {
    const p = state().procs[id];
    return p ? p.runAvg : 0;
}

/**
 * Folds this tick's accumulators into the per-tick averages.
 * @param {number} totalCpu      Game.cpu.getUsed() at the end of the tick
 * @param {number} processCpu    CPU spent inside process runs
 */
function endTick(totalCpu, processCpu) {
    const s = state();
    const first = s.tick.ticks === 0;
    s.tick.cpuAvg = ema(s.tick.cpuAvg, totalCpu, first);
    s.tick.kernelAvg = ema(s.tick.kernelAvg, Math.max(0, totalCpu - processCpu), first);
    s.tick.skippedAvg = ema(s.tick.skippedAvg, s.acc.skipped, first);
    s.tick.lastCpu = totalCpu;
    s.tick.ticks++;
    for (const id in s.procs) {
        const p = s.procs[id];
        p.tickAvg = ema(p.tickAvg, s.acc.procs[id] || 0, false);
    }
    for (const name in s.acc.rooms) {
        if (!(name in s.rooms)) s.rooms[name] = s.acc.rooms[name];
    }
    for (const name in s.rooms) {
        s.rooms[name] = ema(s.rooms[name], s.acc.rooms[name] || 0, false);
    }
    s.acc = { procs: Object.create(null), rooms: Object.create(null), skipped: 0 };
}

/**
 * Processes sorted by their per-tick CPU share.
 * @param {number} [limit]
 * @returns {Array<{id: string} & ProcStat>}
 */
function topProcesses(limit = 10) {
    const s = state();
    return Object.keys(s.procs)
        .map(id => Object.assign({ id }, s.procs[id]))
        .sort((a, b) => b.tickAvg - a.tickAvg)
        .slice(0, limit);
}

/** @param {string} roomName */
function forgetRoom(roomName) {
    delete state().rooms[roomName];
}

module.exports = { record, skipped, estimate, endTick, topProcesses, forgetRoom, state, ALPHA };
