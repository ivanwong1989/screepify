// @ts-check
'use strict';

const bands = require('./bands');
const ledger = require('./ledger');

/**
 * Requests and offers per resource (docs/v2/LOGISTICS.md §2.4), from the
 * store bands and the in-flight ledger. `sense.logistics` publishes the result
 * as `rc.requests`; services/matcher turns it into jobs.
 *
 * @typedef {{id: string, amount: number, prio: number, x: number, y: number}} Entry
 * @typedef {{req: Entry[], off: Entry[]}} ResourceRequests
 * @typedef {{id: string, x: number, y: number, avail: Record<string, number>, free: number}} Buffer
 * @typedef {{byRes: Record<string, ResourceRequests>, buffer: Buffer|null}} Requests
 * @typedef {Record<string, 'fill'|'drain'>} Latch  `${id}:${res}` → what the store is doing
 *
 * Latch (thermostat): a store that dropped below min keeps requesting until it
 * reaches target; one that rose above max keeps offering until it's back at
 * target. Without it a store fed in several loads stops as soon as it's past
 * min. Still no ping-pong: a filling store is ≤ target ≤ max, so it never
 * offers, and a draining one is ≥ target ≥ min, so it never requests.
 */

/** Request priority by structure type (higher first). */
const REQUEST_PRIO = {
    [STRUCTURE_SPAWN]: 100,
    [STRUCTURE_EXTENSION]: 95,
    [STRUCTURE_TOWER]: 80,
    [STRUCTURE_TERMINAL]: 40,
    [STRUCTURE_CONTAINER]: 30
};
/** Offer priority by structure type (higher first). */
const OFFER_PRIO = {
    [STRUCTURE_CONTAINER]: 50,
    [STRUCTURE_TERMINAL]: 40
};

/**
 * @param {any[]} structures  my structures with a store (storage included)
 * @param {import('./ledger').Ledger} l
 * @param {import('./bands').BandInfo} info
 * @param {Latch} [latch]  kept between ticks by the caller (heap); updated here
 * @returns {Requests}
 */
function build(structures, l, info, latch) {
    const lt = latch || {};
    /** @type {Requests} */
    const out = { byRes: {}, buffer: null };
    const slot = (/** @type {string} */ res) => out.byRes[res] || (out.byRes[res] = { req: [], off: [] });
    for (const s of structures) {
        if (bands.isBuffer(s)) {
            /** @type {Record<string, number>} */
            const avail = {};
            for (const r of Object.keys(s.store)) {
                const e = ledger.effective(l, s, r);
                if (e > 0) avail[r] = e;
            }
            let incoming = 0;
            const inc = l.inc[s.id] || {};
            for (const r of Object.keys(inc)) incoming += inc[r];
            out.buffer = { id: s.id, x: s.pos.x, y: s.pos.y, avail, free: Math.max(0, s.store.getFreeCapacity() - incoming) };
            continue;
        }
        for (const res of bands.resourcesOf(s, info)) {
            if (info.blocked && info.blocked.has(`${s.id}:${res}`)) continue;
            const b = bands.band(s, res, info);
            if (!b) continue;
            const e = ledger.effective(l, s, res);
            const key = `${s.id}:${res}`;
            if (e < b.min) lt[key] = 'fill';
            else if (e > b.max) lt[key] = 'drain';
            else if ((lt[key] === 'fill' && e >= b.target) || (lt[key] === 'drain' && e <= b.target)) delete lt[key];
            if (lt[key] === 'fill') {
                const room = s.store.getFreeCapacity(res);
                const n = Math.min(b.target - e, room === null ? Infinity : room);
                if (n > 0) slot(res).req.push({ id: s.id, amount: n, prio: REQUEST_PRIO[s.structureType] || 20, x: s.pos.x, y: s.pos.y });
            } else if (lt[key] === 'drain') {
                const n = Math.min(e - b.target, s.store[res] || 0);
                if (n > 0) slot(res).off.push({ id: s.id, amount: n, prio: OFFER_PRIO[s.structureType] || 45, x: s.pos.x, y: s.pos.y });
            }
        }
    }
    for (const res of Object.keys(out.byRes)) {
        out.byRes[res].req.sort((a, b) => b.prio - a.prio || (a.id < b.id ? -1 : 1));
        out.byRes[res].off.sort((a, b) => b.prio - a.prio || (a.id < b.id ? -1 : 1));
    }
    return out;
}

module.exports = { build, REQUEST_PRIO, OFFER_PRIO };
