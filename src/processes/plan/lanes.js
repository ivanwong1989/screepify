// @ts-check
'use strict';

const cache = require('../../services/cache');
const lanes = require('../../services/lanes');
const laneStore = require('../../services/laneStore');
const log = require('../../services/log');
const policyRules = require('../sense/policy');

/**
 * Builds core lanes (services/lanes) in the background.
 *
 * A burst process: it runs after ACT only while some room needs a lane and
 * the bucket allows, works on one room at a time, and stops each tick after
 * `config.lanes.cpuPerTick` CPU, resuming next time. v1 did the whole search
 * in one tick (up to ~40 candidate ends × 36 routes of PathFinder searches).
 *
 * A room needs a (re)build when it has storage and a spawn, is in phase
 * STORAGE or later, and its saved lane is missing, older than
 * `config.lanes.rebuildEvery` (v1: 500; the lane is saved in Memory now, so
 * an unchanged room needs no rebuild), or built for a different room signature
 * (targets, roads, sites, storage/terminal, links, CORE_END flag).
 */

/** @returns {{job: import('../../services/lanes').LaneJob|null, sig: string}} */
function work() {
    const w = cache.store('lanes.work');
    if (!('job' in w)) {
        w.job = null;
        w.sig = '';
    }
    return /** @type {any} */ (w);
}

/**
 * @param {import('../../contracts/ctx').RoomCtx} rc
 */
function eligible(rc) {
    const room = rc.room;
    return rc.kind === 'owned' && !!room.storage && policyRules.atLeast(rc.policy, 'STORAGE');
}

/**
 * Rooms whose lane should be rebuilt now.
 * @param {import('../../contracts/ctx').TickContext} ctx
 * @returns {Array<{rc: import('../../contracts/ctx').RoomCtx, sig: string}>}
 */
function due(ctx) {
    return cache.perTick('lanes.due', () => {
        const out = [];
        for (const rc of ctx.roomList) {
            if (!eligible(rc)) continue;
            const ln = laneStore.saved(rc.name);
            // Signature checks are staggered; a missing lane is checked every tick.
            if (ln && (ctx.time - ln.t) % ctx.config.lanes.checkEvery !== 0) continue;
            const sig = laneStore.signature(rc.room);
            if (ln && ln.sig === sig && ctx.time - ln.t < ctx.config.lanes.rebuildEvery) continue;
            out.push({ rc, sig });
        }
        return out;
    });
}

/** @type {import('../../contracts/process').Process & Record<string, any>} */
module.exports = {
    id: 'plan.lanes',
    phase: 'PLAN',
    scope: 'shard',
    tier: 'burst',
    bucketNeeded: 500,
    pending(ctx) {
        if (!ctx.config.lanes.enabled) return false;
        return !!work().job || due(ctx).length > 0;
    },
    run(ctx) {
        const w = work();
        if (w.job && !Game.rooms[w.job.room]) w.job = null;
        if (!w.job) {
            const next = due(ctx)[0];
            if (!next) return;
            w.job = lanes.start(next.rc.room);
            w.sig = next.sig;
            if (!w.job) {
                laneStore.clear(next.rc.name);
                return;
            }
        }
        const job = /** @type {import('../../services/lanes').LaneJob} */ (w.job);
        const room = Game.rooms[job.room];
        const t0 = Game.cpu.getUsed();
        const limit = ctx.config.lanes.cpuPerTick;
        if (!lanes.step(room, job, () => Game.cpu.getUsed() - t0 >= limit)) return;
        laneStore.save(job.room, job, w.sig);
        const b = job.best;
        log.info(`[lane] ${job.room}: ${b ? `${b.path.length} tiles, ${b.covered} targets${b.loop ? ', loop' : ''}` : 'none found'}`);
        w.job = null;
    },
    eligible,
    due
};
