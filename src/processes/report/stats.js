// @ts-check
'use strict';

const cache = require('../../services/cache');
const log = require('../../services/log');
const segments = require('../../services/segments');
const telemetry = require('../../kernel/telemetry');

/**
 * Exports stats to a memory segment for gui_data/dashboard.py (DESIGN §14.1).
 * Writing to a segment keeps the payload out of `Memory`, so normal ticks
 * don't pay to parse it.
 */

const STATS_VERSION = 1;

/** @param {number} n */
function round(n) {
    return Math.round(n * 100) / 100;
}

/**
 * @param {import('../../contracts/ctx').TickContext} ctx
 */
function buildRooms(ctx) {
    /** @type {Record<string, any>} */
    const rooms = {};
    const roomCpu = telemetry.state().rooms;
    for (const rc of ctx.roomList) {
        const room = rc.room;
        const ctrl = room.controller;
        rooms[rc.name] = {
            kind: rc.kind,
            rcl: ctrl ? ctrl.level : 0,
            progress: ctrl ? ctrl.progress : 0,
            progressTotal: ctrl ? ctrl.progressTotal : 0,
            energy: room.energyAvailable,
            energyCap: room.energyCapacityAvailable,
            storage: room.storage ? room.storage.store.getUsedCapacity(RESOURCE_ENERGY) : null,
            cpu: round(roomCpu[rc.name] || 0)
        };
    }
    return rooms;
}

/**
 * Builds the payload written to the stats segment.
 * @param {import('../../contracts/ctx').TickContext} ctx
 */
function buildPayload(ctx) {
    const t = telemetry.state().tick;
    const history = cache.store('stats.history');
    if (!history.samples) history.samples = [];
    /** @type {Array<[number, number, number]>} */
    const samples = history.samples;
    samples.push([ctx.time, round(t.cpuAvg), ctx.cpu.bucket]);
    while (samples.length > ctx.config.stats.history) samples.shift();

    let creeps = 0;
    for (const _ in Game.creeps) creeps++;

    return {
        v: STATS_VERSION,
        shard: ctx.shard,
        t: ctx.time,
        cpu: {
            avg: round(t.cpuAvg),
            kernel: round(t.kernelAvg),
            skipped: round(t.skippedAvg),
            limit: ctx.cpu.limit,
            bucket: ctx.cpu.bucket,
            byProcess: telemetry.topProcesses(ctx.config.stats.topProcesses)
                .map(p => [p.id, round(p.tickAvg), round(p.runAvg)])
        },
        gcl: { level: Game.gcl.level, progress: Game.gcl.progress, total: Game.gcl.progressTotal },
        creeps,
        rooms: buildRooms(ctx),
        history: samples
    };
}

/** @type {import('../../contracts/process').Process & {buildPayload: typeof buildPayload}} */
module.exports = {
    id: 'report.stats',
    phase: 'REPORT',
    scope: 'shard',
    // normal, not low: a pixel empties the bucket (D8), and low-tier work pauses
    // below 1,000 bucket, which would black out the dashboard after every pixel.
    tier: 'normal',
    priority: 500,
    every: 20,
    init(ctx) {
        segments.keepActive(ctx.config.stats.segment);
    },
    run(ctx) {
        const segment = ctx.config.stats.segment;
        segments.keepActive(segment);
        const payload = JSON.stringify(buildPayload(ctx));
        const result = segments.write(segment, payload);
        if (result === 'too_large') {
            log.throttled('stats.too_large', 500, () =>
                log.error(`stats payload ${payload.length} chars exceeds segment size`));
        }
    },
    buildPayload
};
