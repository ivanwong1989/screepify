// @ts-check
'use strict';

const laneFit = require('../../services/laneFit');
const laneStore = require('../../services/laneStore');
const log = require('../../services/log');
const movement = require('../../services/movement');
const roomData = require('../../services/roomData');

/**
 * Lane fit builder (services/laneFit): places the next spawn, tower and
 * extension sites next to the room's core lane. For hand-built rooms; off by
 * default (`config.set('laneFit.enabled', true)`, preview with laneFit.show()).
 *
 * Waits while the saved lane is out of date (its signature differs from the
 * room's): plan.lanes rebuilds it first, so a lane reshaped by hand is picked
 * up within a lane check or two, and new sites only go next to the new one.
 * Also waits while hostiles are in the room.
 */

/** @type {import('../../contracts/process').Process} */
module.exports = {
    id: 'plan.laneFit',
    phase: 'PLAN',
    scope: 'room',
    kinds: ['owned'],
    tier: 'low',
    priority: 55,
    every: 100,
    run(ctx, rc) {
        const cfg = ctx.config.laneFit;
        if (!cfg.enabled) return;
        if (cfg.rooms.length > 0 && cfg.rooms.indexOf(rc.name) === -1) return;
        const room = rc.room;
        if (rc.intel && rc.intel.hostiles.length > 0) return;
        const saved = laneStore.saved(room.name);
        if (!saved || saved.sig !== laneStore.signature(room)) return;
        const lane = laneStore.get(room);
        if (!lane) return;
        const open = roomData.sites(room).filter(s => laneFit.TYPES.indexOf(/** @type {any} */ (s.structureType)) !== -1).length;
        const budget = cfg.maxSites - open;
        if (budget <= 0) return;
        const { picks } = laneFit.plan(room, lane, budget);
        let placed = 0;
        for (const p of picks) {
            const code = room.createConstructionSite(p.x, p.y, /** @type {BuildableStructureConstant} */ (p.type));
            if (code === OK) placed++;
            log.info(`[laneFit] ${room.name}: ${p.type} at ${p.x},${p.y} (lane step ${p.d}) → ${code}`);
        }
        if (placed > 0) movement.invalidateRoom(room.name);
    }
};
