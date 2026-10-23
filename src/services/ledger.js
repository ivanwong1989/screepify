// @ts-check
'use strict';

/**
 * In-flight ledger (docs/v2/LOGISTICS.md §2.2). Rebuilt every tick from the
 * creeps themselves, so nothing can go stale when a creep dies:
 *
 * - a committed job (`memory.j`, see Job) counts as outgoing at its source
 *   until picked up, and as incoming at its destination until delivered;
 * - plain withdraw/pickup/transfer tasks (`memory.t`) count the same way.
 *
 * effective(store, res) = store + incoming − outgoing.
 *
 * @typedef {Object} Job   a committed move, in creep.memory.j
 * @property {ResourceConstant} r   resource
 * @property {number} q             amount
 * @property {string|null} f        source id (null: already carried)
 * @property {string} d             destination id
 * @property {'p'|'d'} s            stage: pick up, deliver
 *
 * @typedef {{inc: Record<string, Record<string, number>>, out: Record<string, Record<string, number>>}} Ledger
 */

/** @param {Record<string, Record<string, number>>} map @param {string} id @param {string} res @param {number} n */
function add(map, id, res, n) {
    if (!id || !(n > 0)) return;
    const m = map[id] || (map[id] = {});
    m[res] = (m[res] || 0) + n;
}

/**
 * @param {Iterable<Creep>} creeps
 * @returns {Ledger}
 */
function build(creeps) {
    /** @type {Ledger} */
    const l = { inc: {}, out: {} };
    for (const c of creeps) {
        if (c.spawning) continue;
        const mem = /** @type {any} */ (c.memory);
        const j = /** @type {Job|undefined} */ (mem.j);
        if (j) {
            if (j.s === 'p') {
                if (j.f) add(l.out, j.f, j.r, j.q);
                add(l.inc, j.d, j.r, j.q);
            } else {
                add(l.inc, j.d, j.r, Math.min(j.q, c.store[j.r] || 0));
            }
            continue;
        }
        const t = mem.t;
        if (!t || !t.i) continue;
        const res = t.r || RESOURCE_ENERGY;
        if (t.a === 'withdraw' || t.a === 'pickup') {
            add(l.out, t.i, res, Math.min(t.q || Infinity, c.store.getFreeCapacity(res) || 0));
        } else if (t.a === 'transfer') {
            add(l.inc, t.i, res, Math.min(t.q || Infinity, c.store[res] || 0));
        }
    }
    return l;
}

/**
 * @param {Ledger} l
 * @param {any} s  structure with a store
 * @param {string} res
 */
function effective(l, s, res) {
    const inc = l.inc[s.id] ? l.inc[s.id][res] || 0 : 0;
    const out = l.out[s.id] ? l.out[s.id][res] || 0 : 0;
    return (s.store[res] || 0) + inc - out;
}

module.exports = { build, effective, add };
