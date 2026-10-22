// @ts-check
'use strict';

/**
 * Position helpers. Packed form is "x:y:roomName", used in Memory and heap.
 */

/**
 * @param {{x: number, y: number, roomName: string}} pos
 * @returns {string}
 */
function pack(pos) {
    return `${pos.x}:${pos.y}:${pos.roomName}`;
}

/**
 * @param {string} packed
 * @returns {RoomPosition|null}
 */
function unpack(packed) {
    if (!packed) return null;
    const parts = packed.split(':');
    if (parts.length !== 3) return null;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return new RoomPosition(x, y, parts[2]);
}

/**
 * Converts a RoomPosition or plain {x,y,roomName} to a RoomPosition.
 * @param {any} pos
 * @returns {RoomPosition|null}
 */
function toRoomPosition(pos) {
    if (!pos) return null;
    if (pos instanceof RoomPosition) return pos;
    if (!pos.roomName) return null;
    const x = Number(pos.x);
    const y = Number(pos.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return new RoomPosition(x, y, pos.roomName);
}

/**
 * @param {{x: number, y: number}} pos
 */
function isExit(pos) {
    return pos.x === 0 || pos.y === 0 || pos.x === 49 || pos.y === 49;
}

/**
 * Chebyshev range, same room only (Infinity across rooms).
 * @param {{x: number, y: number, roomName: string}} a
 * @param {{x: number, y: number, roomName: string}} b
 */
function range(a, b) {
    if (a.roomName !== b.roomName) return Infinity;
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Closest by range from a list of objects with `.pos` (same room only).
 * @template {{pos: RoomPosition}} T
 * @param {{x: number, y: number, roomName: string}} from
 * @param {T[]} list
 * @returns {T|null}
 */
function closest(from, list) {
    let best = null;
    let bestR = Infinity;
    for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (!o || !o.pos) continue;
        const r = range(from, o.pos);
        if (r < bestR) {
            bestR = r;
            best = o;
        }
    }
    return best;
}

module.exports = { pack, unpack, toRoomPosition, isExit, range, closest };
