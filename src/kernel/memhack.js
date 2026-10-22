// @ts-check
'use strict';

/**
 * Memory hack (carried over from v1): reuse the parsed Memory object across
 * ticks so the JSON parse cost is only paid once per VM, not every tick.
 */

/** @type {any} */
let parsed = null;

function register() {
    const raw = /** @type {any} */ (RawMemory);
    parsed = raw._parsed || Memory;
}

function runHack() {
    if (!parsed) register();
    const g = /** @type {any} */ (global);
    delete g.Memory;
    g.Memory = parsed;
    /** @type {any} */ (RawMemory)._parsed = parsed;
}

module.exports = { register, runHack };
