// @ts-check
'use strict';

const board = require('../../services/requestBoard');
const matcher = require('../../services/matcher');
const flipGuard = require('../../services/flipGuard');
const movement = require('../../services/movement');

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

/**
 * This tick's request list for a room (built by sense.logistics), or null.
 * @param {Room} room
 * @returns {import('../../services/requests').Requests|null}
 */
function requestsFor(room) {
    return board.get(room.name);
}

/** Storage and terminal next to the creep. @param {Creep} creep */
function headStores(creep) {
    const room = creep.room;
    /** @type {Set<string>} */
    const out = new Set();
    for (const s of [room.storage, room.terminal]) if (s && s.my && creep.pos.isNearTo(s)) out.add(s.id);
    return out;
}

/** @param {Creep} creep @param {import('../../services/ledger').Job} j @param {any} reqs */
function commit(creep, j, reqs) {
    /** @type {any} */ (creep.memory).j = j;
    flipGuard.record(creep.room.name, j, reqs && reqs.buffer ? reqs.buffer.id : null);
}

/**
 * Last resort when no store wants the cargo (storage full): any head store with room.
 * @param {Creep} creep @param {ResourceConstant} res
 */
function overflow(creep, res) {
    const room = creep.room;
    const s = [room.storage, room.terminal].find(x => x && x.my && x.store.getFreeCapacity(res) > 0);
    return s ? s.id : null;
}

/**
 * Continues the committed job. Returns true if it used the tick.
 * @param {Creep} creep
 */
function job(creep) {
    const mem = /** @type {any} */ (creep.memory);
    const j = /** @type {import('../../services/ledger').Job|undefined} */ (mem.j);
    if (!j) return false;
    if (j.s === 'p') {
        const src = /** @type {any} */ (j.f ? Game.getObjectById(/** @type {any} */ (j.f)) : null);
        const n = src ? Math.min(j.q, src.store[j.r] || 0, creep.store.getFreeCapacity(j.r)) : 0;
        if (n <= 0) {
            delete mem.j;
            return false;
        }
        if (!creep.pos.isNearTo(src)) {
            movement.to(creep, src, { range: 1 });
            return true;
        }
        if (creep.withdraw(src, j.r, n) !== OK) {
            delete mem.j;
            return false;
        }
        j.q = n;
        j.s = 'd';
        return true;
    }
    const carried = creep.store[j.r] || 0;
    if (carried <= 0) {
        delete mem.j;
        return false;
    }
    let dst = /** @type {any} */ (Game.getObjectById(/** @type {any} */ (j.d)));
    if (!dst || dst.store.getFreeCapacity(j.r) <= 0) {
        const reqs = requestsFor(creep.room);
        const alt = (reqs && matcher.redirect(reqs, j.r, carried, { exclude: j.d })) || overflow(creep, j.r);
        if (!alt || alt === j.d) {
            delete mem.j;
            return false;
        }
        j.d = alt;
        j.f = null;
        flipGuard.record(creep.room.name, j, reqs && reqs.buffer ? reqs.buffer.id : null);
        dst = Game.getObjectById(/** @type {any} */ (alt));
    }
    if (!creep.pos.isNearTo(dst)) {
        movement.to(creep, dst, { range: 1 });
        return true;
    }
    return creep.transfer(dst, j.r, Math.min(carried, dst.store.getFreeCapacity(j.r))) === OK;
}

/**
 * Commits cargo other than `keep` to where the request list wants it, and
 * starts delivering. Returns true if it used the tick.
 * @param {Creep} creep
 * @param {ResourceConstant|null} keep
 */
function stash(creep, keep) {
    if (/** @type {any} */ (creep.memory).j) return job(creep);
    const res = /** @type {ResourceConstant|undefined} */ (Object.keys(creep.store)
        .find(r => r !== keep && (creep.store[/** @type {ResourceConstant} */ (r)] || 0) > 0));
    if (!res) return false;
    const reqs = requestsFor(creep.room);
    const amount = creep.store[res] || 0;
    const d = (reqs && matcher.redirect(reqs, res, amount, { to: headStores(creep) })) || overflow(creep, res);
    if (!d) return false;
    commit(creep, { r: res, q: amount, f: null, d, s: 'd' }, reqs);
    return job(creep);
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
    const reqs = requestsFor(creep.room);
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
    commit(creep, j, reqs);
    return job(creep);
}

module.exports = { job, stash, start, requestsFor };
