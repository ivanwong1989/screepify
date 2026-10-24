// @ts-check
'use strict';

const cache = require('./cache');

/**
 * When a room last had hauling work off the lanes (supply runs to towers and
 * labs, haul routes, scavenging). Written by the logistics mission, read by
 * the fleet sizing, so the fleet keeps a hauler only while there is work for
 * it (live 2026-10-24: one idle 4,000-energy hauler per room cost about
 * 2.7 energy per tick each).
 */

/** @param {string} roomName */
function note(roomName) {
    cache.store('haul.demand')[roomName] = Game.time;
}

/**
 * @param {string} roomName
 * @param {number} ticks
 */
function recent(roomName, ticks) {
    const t = cache.store('haul.demand')[roomName];
    return t !== undefined && Game.time - t <= ticks;
}

module.exports = { note, recent };
