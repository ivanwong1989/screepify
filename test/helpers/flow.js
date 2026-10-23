'use strict';

/**
 * Audit helpers for logistics soaks (docs/v2/LOGISTICS.md): turn the
 * simulator's carry log into moves between stores, and find stores that
 * gave a resource away and then received it (or the reverse) without an
 * outside change in between.
 */

/**
 * Moves between stores from the carry log: each creep's transfer into a store
 * comes from the store it last withdrew that resource from (null: it never
 * withdrew any, so it harvested or picked it up).
 */
function storeMoves(log) {
    const lastSrc = {};
    const moves = [];
    for (const e of log) {
        const k = `${e.creep}:${e.r}`;
        if (e.a === 'withdraw') lastSrc[k] = e.id;
        else moves.push({ t: e.t, r: e.r, from: lastSrc[k] || null, to: e.id });
    }
    return moves;
}

/**
 * Per (store, resource): direction changes without an outside change at that
 * store. A delivery with no store behind it (harvested, picked up) is inflow
 * from outside, like a terminal receipt.
 */
function flips(moves, bufferId, outside) {
    const last = {};
    const out = [];
    const see = (id, r, dir, t) => {
        if (!id || id === bufferId) return;
        const k = `${id}:${r}`;
        const p = last[k];
        if (p && p.dir !== dir && !(outside[id] || []).some(x => x > p.t && x <= t)) out.push(`${r} ${id}: ${p.dir}@${p.t} → ${dir}@${t}`);
        last[k] = { dir, t };
    };
    for (const m of moves) {
        if (!m.from) {
            (outside[m.to] || (outside[m.to] = [])).push(m.t);
            continue;
        }
        see(m.from, m.r, 'out', m.t);
        see(m.to, m.r, 'in', m.t);
    }
    return out;
}

module.exports = { storeMoves, flips };
