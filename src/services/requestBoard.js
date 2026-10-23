// @ts-check
'use strict';

const cache = require('./cache');

/**
 * Where this tick's logistics request list lives (docs/v2/LOGISTICS.md).
 * `sense.logistics` publishes a builder per room; the list is built the first
 * time anyone asks for it in a tick and reused after that, so ticks where no
 * hauler needs it cost nothing. Readers without ctx (actions, the console)
 * use get(); processes and missions can also read `rc.requests`.
 */

/**
 * @param {string} roomName
 * @param {() => import('./requests').Requests} build
 */
function publish(roomName, build) {
    cache.store('logistics.requests')[roomName] = { t: Game.time, reqs: null, build };
}

/**
 * This tick's list for a room, or null if none was published this tick.
 * @param {string} roomName
 * @returns {import('./requests').Requests|null}
 */
function get(roomName) {
    const e = cache.store('logistics.requests')[roomName];
    if (!e || e.t !== Game.time) return null;
    if (!e.reqs) e.reqs = e.build();
    return e.reqs;
}

module.exports = { publish, get };
