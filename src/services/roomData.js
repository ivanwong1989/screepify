// @ts-check
'use strict';

const cache = require('./cache');

/**
 * Per-tick room lookups (replaces v1's roomCache).
 *
 * Every getter does its `room.find` at most once per tick and only when
 * someone asks, so a process that never needs dropped resources never pays
 * for finding them.
 */

/** @type {string[]} */
let allies = [];

/** @param {string[]} names */
function setAllies(names) {
    allies = Array.isArray(names) ? names : [];
}

/**
 * @template T
 * @param {Room} room
 * @param {string} key
 * @param {() => T} compute
 * @returns {T}
 */
function memo(room, key, compute) {
    return cache.perTick(`rd:${room.name}:${key}`, compute);
}

/** @param {Room} room @returns {Structure[]} */
function structures(room) {
    return memo(room, 'structures', () => room.find(FIND_STRUCTURES));
}

/** @param {Room} room @returns {Record<string, any[]>} */
function structuresByType(room) {
    return memo(room, 'byType', () => {
        /** @type {Record<string, any[]>} */
        const out = {};
        for (const s of structures(room)) {
            (out[s.structureType] || (out[s.structureType] = [])).push(s);
        }
        return out;
    });
}

/**
 * All structures of a type (any owner).
 * @param {Room} room
 * @param {StructureConstant} type
 * @returns {any[]}
 */
function byType(room, type) {
    return structuresByType(room)[type] || [];
}

/**
 * My structures of a type.
 * @param {Room} room
 * @param {StructureConstant} type
 * @returns {any[]}
 */
function myByType(room, type) {
    return memo(room, `my:${type}`, () => byType(room, type).filter(s => s.my));
}

/** @param {Room} room @returns {Source[]} */
function sources(room) {
    return memo(room, 'sources', () => room.find(FIND_SOURCES));
}

/** @param {Room} room @returns {Source[]} */
function activeSources(room) {
    return memo(room, 'sourcesActive', () => sources(room).filter(s => s.energy > 0));
}

/** @param {Room} room @returns {Mineral[]} */
function minerals(room) {
    return memo(room, 'minerals', () => room.find(FIND_MINERALS));
}

/** @param {Room} room @returns {{mine: Creep[], hostile: Creep[]}} */
function creeps(room) {
    return memo(room, 'creeps', () => {
        const mine = [];
        const hostile = [];
        for (const c of room.find(FIND_CREEPS)) {
            if (c.my) mine.push(c);
            else if (!c.owner || allies.indexOf(c.owner.username) === -1) hostile.push(c);
        }
        return { mine, hostile };
    });
}

/** @param {Room} room */
function myCreeps(room) {
    return creeps(room).mine;
}

/** @param {Room} room */
function hostiles(room) {
    return creeps(room).hostile;
}

/** @param {Room} room @returns {Resource[]} */
function dropped(room) {
    return memo(room, 'dropped', () => room.find(FIND_DROPPED_RESOURCES));
}

/** @param {Room} room @returns {Ruin[]} */
function ruins(room) {
    return memo(room, 'ruins', () => room.find(FIND_RUINS));
}

/** @param {Room} room @returns {Tombstone[]} */
function tombstones(room) {
    return memo(room, 'tombstones', () =>
        room.find(FIND_TOMBSTONES).filter(t => t.store && t.store.getUsedCapacity() > 0));
}

/** @param {Room} room @returns {ConstructionSite[]} */
function sites(room) {
    return memo(room, 'sites', () => room.find(FIND_MY_CONSTRUCTION_SITES));
}

/** @param {Room} room @returns {Flag[]} */
function flags(room) {
    return memo(room, 'flags', () => room.find(FIND_FLAGS));
}

module.exports = {
    setAllies, structures, structuresByType, byType, myByType, sources, activeSources,
    minerals, creeps, myCreeps, hostiles, dropped, ruins, tombstones, sites, flags
};
