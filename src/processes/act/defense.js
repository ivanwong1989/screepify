// @ts-check
'use strict';

const log = require('../../services/log');
const roomData = require('../../services/roomData');

/**
 * Safe mode trigger (port of v1 safemodeManager).
 *
 * Activates safe mode when hostiles are present and any of:
 * - a core structure (spawn, storage, terminal) is damaged
 * - a hostile is next to a spawn
 * - a weak rampart (≤ 5,000 hits) next to a core structure has a hostile next to it
 *
 * Config `safeMode`: { enabled, rooms }. Empty `rooms` = every owned room
 * (v1 only watched W44S28).
 */

const WEAK_RAMPART_HITS = 5000;
const NEAR_SPAWN_RANGE = 1;
const RETRY_INTERVAL = 5;

/** @type {import('../../contracts/process').Process} */
module.exports = {
    id: 'act.defense',
    phase: 'ACT',
    scope: 'room',
    kinds: ['owned', 'bootstrap'],
    tier: 'critical',
    priority: 5,
    run(ctx, rc) {
        const cfg = ctx.config.safeMode;
        if (!cfg.enabled) return;
        if (cfg.rooms.length > 0 && cfg.rooms.indexOf(rc.name) === -1) return;
        const room = rc.room;
        const ctrl = room.controller;
        if (!ctrl || !ctrl.my || ctrl.safeMode || !ctrl.safeModeAvailable) return;
        const hostiles = rc.intel ? rc.intel.hostiles : roomData.hostiles(room);
        if (hostiles.length === 0) return;

        const mem = /** @type {any} */ (Memory.rooms[room.name] || (Memory.rooms[room.name] = {}));
        if (mem.smTry && Game.time - mem.smTry < RETRY_INTERVAL) return;

        const spawns = roomData.myByType(room, STRUCTURE_SPAWN);
        /** @type {Structure[]} */
        const core = [].concat(spawns, room.storage ? [room.storage] : [], room.terminal ? [room.terminal] : []);
        const coreDamaged = core.some(s => s.hits < s.hitsMax);
        const nearSpawn = spawns.some(sp => hostiles.some(h => sp.pos.getRangeTo(h) <= NEAR_SPAWN_RANGE));
        const weakRamp = roomData.myByType(room, STRUCTURE_RAMPART).some(r =>
            r.hits <= WEAK_RAMPART_HITS &&
            core.some(s => r.pos.getRangeTo(s) <= 1) &&
            hostiles.some(h => r.pos.getRangeTo(h) <= 1));
        if (!coreDamaged && !nearSpawn && !weakRamp) return;

        mem.smTry = Game.time;
        const res = ctrl.activateSafeMode();
        log.info(`[SafeMode] ${room.name} ${res === OK ? 'activated' : `activate FAILED (${res})`} ` +
            `coreDamaged=${+coreDamaged} nearSpawn=${+nearSpawn} weakRamp=${+weakRamp}`);
    }
};
