// @ts-check
'use strict';

const roomData = require('../../services/roomData');
const { pack } = require('../../services/pos');

/**
 * "Don't work while standing next to a source" policy (port of v1
 * _policy_vacate_source). Workers that build/repair/upgrade from a tile
 * adjacent to a source block the static miner's slots; this moves them to a
 * free tile in work range that isn't next to a source.
 */

const MINER_ARCHETYPES = ['miner', 'remote_miner'];
const SOURCE_INFRA = [STRUCTURE_CONTAINER, STRUCTURE_ROAD, STRUCTURE_LINK];

/**
 * @param {{x: number, y: number}} p
 * @param {Source[]} sources
 */
function nearSource(p, sources) {
    for (const s of sources) {
        if (Math.max(Math.abs(s.pos.x - p.x), Math.abs(s.pos.y - p.y)) <= 1) return true;
    }
    return false;
}

/**
 * @param {Room} room
 * @param {number} x
 * @param {number} y
 */
function walkable(room, x, y) {
    if (x < 0 || x > 49 || y < 0 || y > 49) return false;
    if (room.getTerrain().get(x, y) === TERRAIN_MASK_WALL) return false;
    for (const s of room.lookForAt(LOOK_STRUCTURES, x, y)) {
        const t = s.structureType;
        if (t === STRUCTURE_ROAD || t === STRUCTURE_CONTAINER) continue;
        if (t === STRUCTURE_RAMPART && (/** @type {any} */ (s).my || /** @type {any} */ (s).isPublic)) continue;
        return false;
    }
    return true;
}

/**
 * @param {Room} room
 * @param {number} x
 * @param {number} y
 * @param {string} selfId
 */
function occupied(room, x, y, selfId) {
    const creeps = room.lookForAt(LOOK_CREEPS, x, y);
    return creeps.length > 0 && !(creeps.length === 1 && creeps[0].id === selfId);
}

/**
 * Returns a move task off the source tiles, or null if the creep may work where it is.
 * @param {Creep} creep
 * @param {'build'|'repair'|'upgrade'} kind
 * @param {{pos: RoomPosition, structureType?: string}} target
 * @param {number} workRange
 * @returns {import('../../contracts/task').Task|null}
 */
function vacate(creep, kind, target, workRange) {
    const room = creep.room;
    const sources = roomData.sources(room);
    if (sources.length === 0 || !nearSource(creep.pos, sources)) return null;

    if (kind === 'repair' && MINER_ARCHETYPES.indexOf(creep.memory.a) !== -1 &&
        SOURCE_INFRA.indexOf(/** @type {any} */ (target.structureType)) !== -1 &&
        nearSource(target.pos, sources)) {
        return null;
    }

    let best = null;
    let bestRange = Infinity;
    for (let dx = -workRange; dx <= workRange; dx++) {
        for (let dy = -workRange; dy <= workRange; dy++) {
            const x = target.pos.x + dx;
            const y = target.pos.y + dy;
            if (!walkable(room, x, y)) continue;
            if (nearSource({ x, y }, sources)) continue;
            if (occupied(room, x, y, creep.id)) continue;
            const r = creep.pos.getRangeTo(x, y);
            if (r < bestRange) {
                bestRange = r;
                best = { x, y };
            }
        }
    }
    if (best) return { a: 'move', p: pack({ x: best.x, y: best.y, roomName: room.name }), n: 0 };

    // Fallback: step one tile further from the nearest source.
    const src = creep.pos.findClosestByRange(sources);
    if (!src) return null;
    let fallback = null;
    let far = creep.pos.getRangeTo(src.pos);
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const x = creep.pos.x + dx;
            const y = creep.pos.y + dy;
            if (!walkable(room, x, y) || occupied(room, x, y, creep.id)) continue;
            const r = Math.max(Math.abs(src.pos.x - x), Math.abs(src.pos.y - y));
            if (r > far) {
                far = r;
                fallback = { x, y };
            }
        }
    }
    return fallback ? { a: 'move', p: pack({ x: fallback.x, y: fallback.y, roomName: room.name }), n: 0 } : null;
}

module.exports = { vacate };
