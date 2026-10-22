'use strict';

const path = require('path');
const { performance } = require('perf_hooks');
const { createWorld } = require('./sim');

const ROOT = path.join(__dirname, '..', '..');

/** A small room used by the simulation tests. */
const DEFAULT_ROOM = {
    spawn: [25, 25], sources: [[10, 12], [40, 36]], controller: [26, 8],
    walls: [[11, 11], [9, 13], [39, 35]], swamps: [[30, 30], [31, 30]]
};

/**
 * Boots the bot in a fresh simulated room and returns a runner.
 * - `bundle: true` runs dist/main.js (build first) instead of src/main.js
 * - `deterministic: true` makes Game.cpu.getUsed() return 0 (no budget skips)
 * @param {Parameters<typeof createWorld>[0]} [spec]
 * @param {{bundle?: boolean, deterministic?: boolean, config?: object}} [opts]
 */
function boot(spec, opts) {
    spec = spec || DEFAULT_ROOM;
    opts = opts || {};
    const world = createWorld(spec);
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(path.join(ROOT, 'src'))) delete require.cache[key];
    }
    delete global.__v2heap;
    const logs = [];
    const realLog = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    let tickStart = 0;
    global.Game.cpu.getUsed = opts.deterministic ? () => 0 : () => performance.now() - tickStart;
    if (opts.config) global.Memory.config = opts.config;
    let main;
    try {
        if (opts.bundle) {
            const code = require('fs').readFileSync(path.join(ROOT, 'dist', 'main.js'), 'utf8');
            const mod = { exports: {} };
            new Function('module', 'exports', code)(mod, mod.exports);
            main = mod.exports;
        } else {
            main = require(path.join(ROOT, 'src', 'main.js'));
        }
    } finally {
        console.log = realLog;
    }
    const times = [];
    return {
        world,
        logs,
        times,
        run(ticks, onTick) {
            console.log = (...a) => logs.push(`[${global.Game.time}] ` + a.join(' '));
            try {
                for (let i = 0; i < ticks; i++) {
                    tickStart = performance.now();
                    main.loop();
                    times.push(performance.now() - tickStart);
                    if (onTick) onTick(world);
                    world.endTick();
                }
            } finally {
                console.log = realLog;
            }
        }
    };
}

module.exports = { boot, DEFAULT_ROOM };
