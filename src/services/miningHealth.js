// @ts-check
'use strict';

const cache = require('./cache');
const log = require('./log');
const STALL_TICKS = 20;
const RECOVERY_COOLDOWN = 50;

/** @param {string} id */
function entry(id) {
    const store = cache.store('mining.health');
    if (!store[id]) store[id] = { lastHarvest: null, observed: Game.time, intents: 0, recoveryAt: null, reason: 'starting', samples: [] };
    return store[id];
}

/** Successful API intent, not engine-resolved energy. @param {string} id @param {number} [amount] @param {number} [available] */
function harvested(id, amount = 0, available = Infinity) {
    const h = entry(id);
    h.lastHarvest = Game.time;
    h.intents++;
    const sample = h.samples[h.samples.length - 1];
    if (sample && sample[0] === Game.time) {
        sample[1]++;
        sample[2] += Math.max(0, Math.min(amount, available - sample[2]));
    } else h.samples.push([Game.time, 1, Math.min(amount, available)]);
    h.reason = 'harvesting';
}

/** @param {import('../contracts/ctx').RoomCtx} rc */
function observe(rc) {
    const live = new Set();
    for (const m of rc.missions || []) {
        if (m.type !== 'harvest') continue;
        const d = /** @type {any} */ (m.data);
        const s = Game.getObjectById(/** @type {Id<Source>} */ (d.sourceId));
        if (!s) continue;
        live.add(s.id);
        const h = entry(s.id);
        h.room = rc.name;
        h.mode = d.mode;
        h.miners = (rc.census ? rc.census.active : []).filter(c => c.memory.m === m.id);
        h.work = h.miners.reduce((n, c) => n + c.getActiveBodyparts(WORK), 0);
        const container = d.containerId && Game.getObjectById(/** @type {Id<StructureContainer>} */ (d.containerId));
        const near = h.miners.some(c => c.pos.inRangeTo(s.pos, 3));
        while (h.samples.length && h.samples[0][0] <= Game.time - 100) h.samples.shift();
        if (h.lastHarvest === Game.time) { h.reason = 'harvesting'; h.blockedSince = null; }
        else if (s.energy === 0) { h.reason = 'regenerating'; h.blockedSince = null; }
        else if (!h.miners.length || !h.work) { h.reason = 'no_miner'; h.blockedSince = null; }
        else if (container && container.store.getFreeCapacity(RESOURCE_ENERGY) === 0) { h.reason = 'container_full'; h.blockedSince = null; }
        else if (!near) { h.reason = 'travelling'; h.blockedSince = null; }
        else if (d.mode === 'mobile') { h.reason = 'mobile_cycle'; h.blockedSince = null; }
        else {
            if (h.blockedSince == null) h.blockedSince = Game.time;
            h.reason = Game.time - h.blockedSince >= STALL_TICKS ? 'position_blocked' : 'positioning';
            if (h.reason === 'position_blocked' && (h.recoveryAt == null || Game.time - h.recoveryAt >= RECOVERY_COOLDOWN)) {
                h.recoveryAt = Game.time;
                for (const c of h.miners) delete c.memory.t;
                // Rebuild positions next tick; never create extra spawn demand.
                delete cache.store('mining.stations')[m.id];
                log.throttled(`mining:${s.id}`, RECOVERY_COOLDOWN, () => log.info(`[mining] ${rc.name} ${s.id}: no harvest for ${Game.time - h.blockedSince} ticks; reconcile positions`));
            }
        }
        h.t = Game.time;
    }
    const store = cache.store('mining.health');
    for (const id in store) if (store[id].room === rc.name && !live.has(id)) delete store[id];
}

/** @param {string} room */
function snapshot(room) {
    const out = {};
    const states = cache.store('mining.stations');
    const targets = cache.store('mining.targets');
    const store = cache.store('mining.health');
    for (const id in store) {
        const h = store[id];
        if (h.room !== room) continue;
        const station = states[`harvest:${id}`];
        const container = station && Game.getObjectById(/** @type {Id<StructureContainer>} */ (station.container));
        out[id] = {
            mode: h.mode, lastHarvest: h.lastHarvest, successfulIntents100: h.samples.reduce((n, s) => n + s[1], 0),
            estimatedHarvest100: h.samples.reduce((n, s) => n + s[2], 0),
            work: h.work, owner: station ? station.owner : null,
            occupant: container ? (container.pos.lookFor(LOOK_CREEPS)[0] || {}).name || null : null,
            reason: h.reason, blockedTicks: h.blockedSince == null ? 0 : Game.time - h.blockedSince,
            miners: (h.miners || []).map(c => ({ name: c.name, target: targets[c.name] ? targets[c.name].target : null, role: targets[c.name] ? targets[c.name].reason : null }))
        };
    }
    return out;
}

module.exports = { harvested, observe, snapshot, STALL_TICKS, RECOVERY_COOLDOWN };
