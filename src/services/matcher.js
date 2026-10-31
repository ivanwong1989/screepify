// @ts-check
'use strict';

/**
 * Matcher (docs/v2/LOGISTICS.md §2.3–2.4): turns `rc.requests` into one job
 * for one hauler. Every hauler that moves resources between stores goes
 * through here, so there is one set of rules.
 *
 * - A request is filled from an offer of the same resource, else from the
 *   buffer (storage). An offer nobody requests goes to the buffer. Never
 *   buffer → buffer.
 * - The amount is at most min(carry, request up to target, offer down to target),
 *   so neither side is pushed across its band and wants the opposite move.
 * - Taking a job updates the request list at once, so a second hauler in the
 *   same tick doesn't take the same amount (the ledger takes over next tick).
 *
 * @typedef {import('./requests').Requests} Requests
 * @typedef {import('./requests').Entry} Entry
 * @typedef {import('./ledger').Job} Job
 *
 * @typedef {Object} PickOpts
 * @property {number} cap                    free carry capacity
 * @property {{x: number, y: number}} [pos]  for distance tie-breaks
 * @property {Set<string>|null} [from]       allowed source ids (null: any)
 * @property {Set<string>|null} [to]         allowed destination ids (null: any)
 * @property {string|null} [res]             only this resource
 * @property {number} [min]                  ignore jobs smaller than this (default 1)
 * @property {Set<string>|null} [touch]      job must start or end at one of these ids
 */

/** Offers to the buffer rank below every real request. */
const TO_BUFFER_PENALTY = 100;

/** @param {Set<string>|null|undefined} set @param {string} id */
const allowed = (set, id) => !set || set.has(id);

/** @param {{x: number, y: number}|undefined} a @param {{x: number, y: number}} b */
const dist = (a, b) => (a ? Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) : 0);

/**
 * Best job for one hauler, committed into `reqs`, or null.
 * @param {Requests} reqs
 * @param {PickOpts} o
 * @returns {Job|null}
 */
function pick(reqs, o) {
    const min = Math.max(1, o.min || 1);
    const buf = reqs.buffer;
    /** @type {{score: number, d: number, res: string, q: number, src: Entry|null, dst: Entry|null}|null} */
    let best = null;
    /** @param {number} score @param {number} d @param {string} res @param {number} q @param {Entry|null} src @param {Entry|null} dst */
    const consider = (score, d, res, q, src, dst) => {
        if (q < min) return;
        if (o.touch && !((src && o.touch.has(src.id)) || (dst && o.touch.has(dst.id)))) return;
        if (!best || score > best.score || (score === best.score && (d < best.d || (d === best.d && q > best.q)))) {
            best = { score, d, res, q, src, dst };
        }
    };
    for (const res of Object.keys(reqs.byRes)) {
        if (o.res && res !== o.res) continue;
        const { req, off } = reqs.byRes[res];
        const offers = off.filter(e => e.amount > 0 && allowed(o.from, e.id));
        const bufAvail = buf && allowed(o.from, buf.id) ? buf.avail[res] || 0 : 0;
        for (const r of req) {
            if (r.amount <= 0 || !allowed(o.to, r.id)) continue;
            const src = offers.find(e => e.id !== r.id && (!e.to || e.to.includes(r.id))) || null;
            if (src) consider(r.prio, dist(o.pos, src), res, Math.min(o.cap, r.amount, src.amount), src, r);
            else if (bufAvail > 0 && buf) consider(r.prio, dist(o.pos, buf), res, Math.min(o.cap, r.amount, bufAvail), null, r);
        }
        if (buf && allowed(o.to, buf.id) && buf.free > 0) {
            for (const e of offers.filter(e => !e.to)) consider(e.prio - TO_BUFFER_PENALTY, dist(o.pos, e), res, Math.min(o.cap, e.amount, buf.free), e, null);
        }
    }
    if (!best) return null;
    const b = /** @type {{score: number, d: number, res: string, q: number, src: Entry|null, dst: Entry|null}} */ (best);
    const bufId = buf ? buf.id : '';
    if (b.src) b.src.amount -= b.q;
    else if (buf) buf.avail[b.res] = (buf.avail[b.res] || 0) - b.q;
    if (b.dst) b.dst.amount -= b.q;
    else if (buf) buf.free -= b.q;
    return { r: /** @type {ResourceConstant} */ (b.res), q: b.q, f: b.src ? b.src.id : bufId, d: b.dst ? b.dst.id : bufId, s: 'p' };
}

/**
 * Where carried cargo should go when its job's destination no longer wants it:
 * the best request for that resource, else the buffer. Committed into `reqs`.
 * @param {Requests} reqs
 * @param {string} res
 * @param {number} amount
 * @param {{to?: Set<string>|null, exclude?: string}} [o]
 * @returns {string|null} destination id
 */
function redirect(reqs, res, amount, o) {
    const opts = o || {};
    const slot = reqs.byRes[res];
    const r = slot ? slot.req.find(e => e.amount > 0 && e.id !== opts.exclude && allowed(opts.to, e.id)) : null;
    if (r) {
        r.amount -= Math.min(r.amount, amount);
        return r.id;
    }
    const buf = reqs.buffer;
    if (buf && buf.id !== opts.exclude && buf.free > 0 && allowed(opts.to, buf.id)) {
        buf.free -= amount;
        return buf.id;
    }
    return null;
}

module.exports = { pick, redirect, TO_BUFFER_PENALTY };
