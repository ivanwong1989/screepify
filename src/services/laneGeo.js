// @ts-check
'use strict';

/** Packed-tile helpers for lanes (y * 50 + x). */

/** @typedef {import('./lanes').LaneTarget} LaneTarget */

/** @param {number} x @param {number} y */
function pack(x, y) {
    return y * 50 + x;
}

/** @param {number} p */
function px(p) {
    return p % 50;
}

/** @param {number} p */
function py(p) {
    return (p - (p % 50)) / 50;
}

/** Chebyshev range between packed tiles. @param {number} a @param {number} b */
function range(a, b) {
    return Math.max(Math.abs(px(a) - px(b)), Math.abs(py(a) - py(b)));
}

/**
 * Number of targets next to a tile.
 * @param {number} p
 * @param {LaneTarget[]} tgts
 */
function adjacent(p, tgts) {
    const x = px(p);
    const y = py(p);
    let n = 0;
    for (const t of tgts) if (Math.abs(t.x - x) <= 1 && Math.abs(t.y - y) <= 1) n++;
    return n;
}

module.exports = { pack, px, py, range, adjacent };
