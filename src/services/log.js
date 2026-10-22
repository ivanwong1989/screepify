// @ts-check
'use strict';

const cache = require('./cache');

/**
 * Console logging with debug categories and throttling.
 * Categories are toggled via config `debug.<category> = true` (DESIGN §11).
 */

/** @type {Record<string, boolean>} */
let enabledCategories = {};

/** @param {Record<string, boolean>} categories */
function setCategories(categories) {
    enabledCategories = categories || {};
}

/** @param {string} category */
function isDebug(category) {
    return !!enabledCategories[category] || !!enabledCategories.all;
}

/**
 * @param {string} category
 * @param {...any} args
 */
function debug(category, ...args) {
    if (!isDebug(category)) return;
    console.log(`[${Game.time}][${category}]`, ...args);
}

/** @param {...any} args */
function info(...args) {
    console.log(`[${Game.time}]`, ...args);
}

/** @param {...any} args */
function error(...args) {
    console.log(`<span style="color:#ff6b6b">[${Game.time}][ERROR]</span>`, ...args);
}

/**
 * Logs at most once every `interval` ticks per key.
 * @param {string} key
 * @param {number} interval
 * @param {() => void} emit
 */
function throttled(key, interval, emit) {
    const last = cache.store('log.throttle');
    const prev = last[key];
    if (prev !== undefined && Game.time - prev < interval) return;
    last[key] = Game.time;
    emit();
}

module.exports = { setCategories, isDebug, debug, info, error, throttled };
