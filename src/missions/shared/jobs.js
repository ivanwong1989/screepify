// @ts-check
'use strict';

const board = require('../../services/requestBoard');
const matcher = require('../../services/matcher');
const flipGuard = require('../../services/flipGuard');
const movement = require('../../services/movement');

/**
 * Committed jobs (docs/v2/LOGISTICS.md §2.3), shared by every hauler that moves
 * resources between stores through the matcher (core lane hauler at the head,
 * lab hauler). A job lives in `memory.j` (services/ledger Job): pick up, then
 * deliver. A destination that no longer wants the cargo is swapped for the
 * next request for that resource, else storage. Every commit is recorded by
 * services/flipGuard.
 */

/**
 * This tick's request list for a room (built by sense.logistics), or null.
 * @param {Room} room
 * @returns {import('../../services/requests').Requests|null}
 */
function requestsFor(room) {
    return board.get(room.name);
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
 * @param {Set<string>|null} [to]  allowed destinations (null: any)
 */
function stash(creep, keep, to) {
    if (/** @type {any} */ (creep.memory).j) return job(creep);
    const res = /** @type {ResourceConstant|undefined} */ (Object.keys(creep.store)
        .find(r => r !== keep && (creep.store[/** @type {ResourceConstant} */ (r)] || 0) > 0));
    if (!res) return false;
    const reqs = requestsFor(creep.room);
    const amount = creep.store[res] || 0;
    const d = (reqs && matcher.redirect(reqs, res, amount, { to: to || null })) || overflow(creep, res);
    if (!d) return false;
    commit(creep, { r: res, q: amount, f: null, d, s: 'd' }, reqs);
    return job(creep);
}

module.exports = { requestsFor, commit, overflow, job, stash };
