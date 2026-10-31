// @ts-check
'use strict';

const cache = require('./cache');
const roomData = require('./roomData');
const GRACE_TICKS = 25;

/** @param {import('../contracts/ctx').RoomCtx} rc @param {any} source */
function ready(rc, source) {
    const active = rc.census ? rc.census.active : [];
    const generic = active.some(c => c.memory.a === 'hauler' && c.room.name === rc.name && c.getActiveBodyparts(CARRY) > 0);
    const mining = source.containerId && active.some(c => c.memory.a === 'miningHauler' && c.room.name === rc.name && c.memory.m === `mlane:${source.id}` && c.getActiveBodyparts(CARRY) > 0);
    const links = roomData.myByType(rc.room, STRUCTURE_LINK);
    const direct = source.linkId && links.some(l => l.id === source.linkId) && links.some(l => l.id !== source.linkId && !rc.intel.sources.some(s => l.pos.inRangeTo(s.pos, 2)));
    const live = !!(generic || mining || direct);
    const store = cache.store('mining.readiness');
    const key = `${rc.name}:${source.id}:${source.containerId || '-'}:${source.linkId || '-'}`;
    if (live) store[key] = Game.time;
    return live || (store[key] !== undefined && Game.time - store[key] <= GRACE_TICKS);
}

/** Harvest plans must refresh on hauling and source-infrastructure transitions. @param {import('../contracts/ctx').RoomCtx} rc */
function signature(rc) {
    return rc.intel.sources.map(s => `${s.id}:${s.containerId || '-'}:${s.linkId || '-'}:${Number(ready(rc, s))}`).join('|');
}

module.exports = { ready, signature, GRACE_TICKS };
