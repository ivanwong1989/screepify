// @ts-check
'use strict';

const cache = require('../../services/cache');

/**
 * Census: who belongs to this room and what they're doing.
 *
 * One pass over Game.creeps per tick (shared by all rooms) groups creeps by
 * home room. Per room it then counts creeps per mission and per archetype,
 * and totals the energy already promised to gathering creeps (reservations),
 * replacing v1's per-tick `room._reservedEnergy` rebuild.
 */

/**
 * @typedef {{count: number, work: number, carry: number, claim: number}} Tally
 *
 * @typedef {Object} Census
 * @property {Creep[]} creeps                  all creeps with this home (incl. spawning)
 * @property {Creep[]} active                  not spawning
 * @property {Record<string, Tally>} byMission active creeps per mission id
 * @property {Record<string, Tally>} byMissionAll  incl. spawning (for mission generators)
 * @property {Record<string, Creep[]>} byArchetype  incl. spawning
 * @property {Record<string, number>} reserved energy promised per gather target id
 */

/** @returns {Record<string, Creep[]>} */
function creepsByHome() {
    return cache.perTick('census.byHome', () => {
        /** @type {Record<string, Creep[]>} */
        const out = {};
        for (const name in Game.creeps) {
            const c = Game.creeps[name];
            const home = c.memory && c.memory.h;
            if (!home) continue;
            (out[home] || (out[home] = [])).push(c);
        }
        return out;
    });
}

/**
 * Active parts by type, per tick.
 * @param {Creep} creep
 * @returns {{work: number, carry: number, claim: number}}
 */
function parts(creep) {
    return cache.perTick(`parts:${creep.name}`, () => {
        let work = 0;
        let carry = 0;
        let claim = 0;
        for (const p of creep.body) {
            if (p.hits <= 0) continue;
            if (p.type === WORK) work++;
            else if (p.type === CARRY) carry++;
            else if (p.type === CLAIM) claim++;
        }
        return { work, carry, claim };
    });
}

/**
 * @param {Record<string, Tally>} map
 * @param {string} id
 * @param {Creep} creep
 */
function tally(map, id, creep) {
    const t = map[id] || (map[id] = { count: 0, work: 0, carry: 0, claim: 0 });
    const p = parts(creep);
    t.count++;
    t.work += p.work;
    t.carry += p.carry;
    t.claim += p.claim;
}

/**
 * @param {string} roomName
 * @returns {Census}
 */
function build(roomName) {
    const creeps = creepsByHome()[roomName] || [];
    /** @type {Census} */
    const c = { creeps, active: [], byMission: {}, byMissionAll: {}, byArchetype: {}, reserved: {} };
    for (const creep of creeps) {
        const mem = creep.memory;
        (c.byArchetype[mem.a] || (c.byArchetype[mem.a] = [])).push(creep);
        if (mem.m) tally(c.byMissionAll, mem.m, creep);
        if (creep.spawning) continue;
        c.active.push(creep);
        if (mem.m) tally(c.byMission, mem.m, creep);
        const t = mem.t;
        if (t && t.i && (t.a === 'withdraw' || t.a === 'pickup') && (!t.r || t.r === RESOURCE_ENERGY)) {
            c.reserved[t.i] = (c.reserved[t.i] || 0) + creep.store.getFreeCapacity();
        }
    }
    return c;
}

/** @type {import('../../contracts/process').Process & {build: typeof build, parts: typeof parts}} */
module.exports = {
    id: 'sense.census',
    phase: 'SENSE',
    scope: 'room',
    kinds: ['owned', 'bootstrap'],
    tier: 'critical',
    priority: 20,
    run(ctx, rc) {
        rc.census = build(rc.name);
    },
    build,
    parts
};
