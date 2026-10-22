'use strict';

/**
 * Minimal Screeps world mock for node:test.
 *
 * - CPU is a manual clock: `world.spend(n)` advances Game.cpu.getUsed().
 * - `world.nextTick()` advances Game.time, resets the clock, persists segment
 *   writes and activates the segments requested last tick (one-tick delay, like
 *   the real game).
 */

const ROOT = require('path').join(__dirname, '..', '..');

/**
 * @param {string} name
 * @param {{my?: boolean, level?: number}} [opts]
 */
function makeRoom(name, opts = {}) {
    const my = opts.my !== false;
    return {
        name,
        controller: { my, level: opts.level || 1, progress: 0, progressTotal: 200 },
        energyAvailable: 300,
        energyCapacityAvailable: 300,
        storage: undefined
    };
}

/**
 * @param {{time?: number, bucket?: number, limit?: number, shard?: string,
 *          rooms?: Record<string, any>, memory?: any}} [opts]
 */
function setup(opts = {}) {
    const clock = { now: 0 };
    const segStore = {};
    const logs = [];
    const realLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    global.OK = 0;
    global.ERR_NOT_ENOUGH_RESOURCES = -6;
    global.RESOURCE_ENERGY = 'energy';

    global.Memory = opts.memory || {};
    global.RawMemory = {
        segments: {},
        _active: [],
        setActiveSegments(ids) {
            this._active = ids.slice();
        }
    };

    const cpu = {
        limit: opts.limit === undefined ? 20 : opts.limit,
        bucket: opts.bucket === undefined ? 5000 : opts.bucket,
        tickLimit: 500,
        getUsed: () => clock.now,
        pixelsGenerated: 0,
        generatePixel() {
            if (this.bucket < 10000) return global.ERR_NOT_ENOUGH_RESOURCES;
            this.bucket -= 10000;
            this.pixelsGenerated++;
            return global.OK;
        }
    };

    global.Game = {
        time: opts.time === undefined ? 100 : opts.time,
        shard: { name: opts.shard || 'shard3' },
        cpu,
        rooms: opts.rooms || {},
        creeps: {},
        gcl: { level: 1, progress: 0, progressTotal: 1000 }
    };

    delete global.__v2heap;
    // Fresh module state per test (config caches the effective config).
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(ROOT + '/src/')) delete require.cache[key];
    }

    return {
        clock,
        logs,
        segStore,
        /** @param {number} n */
        spend(n) {
            clock.now += n;
        },
        nextTick() {
            // Unused CPU refills the bucket, like the real game.
            const c = global.Game.cpu;
            c.bucket = Math.min(10000, c.bucket + Math.max(0, c.limit - clock.now));
            for (const id of Object.keys(global.RawMemory.segments)) {
                segStore[id] = global.RawMemory.segments[id];
            }
            global.RawMemory.segments = {};
            for (const id of global.RawMemory._active) {
                global.RawMemory.segments[id] = segStore[id] === undefined ? '' : segStore[id];
            }
            global.Game.time++;
            clock.now = 0;
        },
        restore() {
            console.log = realLog;
        }
    };
}

/**
 * Builds a test process.
 * @param {Partial<import('../../src/contracts/process').Process> & {id: string}} p
 */
function proc(p) {
    return Object.assign({ phase: 'ACT', scope: 'shard', tier: 'normal', run() {} }, p);
}

module.exports = { setup, makeRoom, proc };
