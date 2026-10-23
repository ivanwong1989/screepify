// @ts-check
'use strict';

const matcher = require('../../services/matcher');
const jobs = require('./jobs');

/**
 * The core lane hauler at the head (docs/v2/LOGISTICS.md step L2). Everything
 * it moves between stores goes through the matcher; it has no rules of its
 * own about where things go.
 *
 * - job():   continue the committed job in `memory.j` (services/ledger Job):
 *            pick up, then deliver. A destination that no longer wants the
 *            cargo is swapped for the next request for that resource, else
 *            storage. Committed jobs are finished before a lane run starts.
 * - stash(): commit leftover cargo (after a lane run, a link drain) to the
 *            best request for it, else storage.
 * - start(): when idle and empty, take one job between the head's stores
 *            (storage ↔ terminal: terminal band, P11 stock targets). With
 *            nothing to do it looks again after IDLE_RECHECK ticks (memory.sn).
 *
 * Every committed job is recorded by services/flipGuard.
 */

const IDLE_RECHECK = 5;

/** Storage and terminal next to the creep. @param {Creep} creep */
function headStores(creep) {
    const room = creep.room;
    /** @type {Set<string>} */
    const out = new Set();
    for (const s of [room.storage, room.terminal]) if (s && s.my && creep.pos.isNearTo(s)) out.add(s.id);
    return out;
}

/**
 * Commits cargo other than `keep` to where the request list wants it (a head
 * store), and starts delivering. Returns true if it used the tick.
 * @param {Creep} creep
 * @param {ResourceConstant|null} keep
 */
function stash(creep, keep) {
    return jobs.stash(creep, keep, headStores(creep));
}

/**
 * Idle and empty at the head: take one job between the head's stores.
 * Returns true if it used the tick.
 * @param {Creep} creep
 */
function start(creep) {
    const mem = /** @type {any} */ (creep.memory);
    if (mem.j || creep.store.getUsedCapacity() > 0) return false;
    if (mem.sn && Game.time < mem.sn) return false;
    const reqs = jobs.requestsFor(creep.room);
    if (!reqs) return false;
    const head = headStores(creep);
    if (head.size < 2) return false;
    const j = matcher.pick(reqs, { cap: creep.store.getFreeCapacity(), from: head, to: head, pos: creep.pos });
    if (!j) {
        // Nothing to do at the head: look again in a few ticks, not every tick.
        mem.sn = Game.time + IDLE_RECHECK;
        return false;
    }
    delete mem.sn;
    jobs.commit(creep, j, reqs);
    return jobs.job(creep);
}

module.exports = { job: jobs.job, stash, start };
