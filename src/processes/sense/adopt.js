// @ts-check
'use strict';

const cache = require('../../services/cache');
const log = require('../../services/log');

/**
 * Adopts creeps without v2 memory (after the v1 → v2 wipe, or a manual
 * Memory reset), so they go back to work instead of idling until they die.
 *
 * Home: the room they stand in if it's mine, else the closest room of mine.
 * Archetype from the active body (v1 body recipes):
 *   ≥ 2 WORK, at most 1 CARRY and 1 MOVE          → miner  (static miner)
 *   WORK with MOVE = 2 × WORK and CARRY = WORK    → miner  (mobile miner)
 *   other WORK + CARRY (incl. 1 WORK/CARRY/MOVE)  → worker
 *   CARRY with CARRY ≥ 1.5 × MOVE (road body)     → laneHauler
 *   other CARRY                                   → hauler
 * Creeps with ATTACK / RANGED_ATTACK / HEAL / CLAIM, scouts, or no home in
 * reach are left alone (no v2 missions for them yet); they are checked once
 * per VM, not every tick.
 *
 * Missions then assign them like any other creep; the spawner binds them to
 * free slots so it doesn't spawn duplicates (act.spawns bindStrays).
 */

/**
 * @param {{work: number, carry: number, move: number, other: number}} b
 * @returns {string|null}
 */
function archetype(b) {
    if (b.other > 0) return null;
    if (b.work > 0) {
        if (b.work >= 2 && b.carry <= 1 && b.move <= 1) return 'miner';
        if (b.move === 2 * b.work && b.carry === b.work) return 'miner';
        return b.carry > 0 ? 'worker' : 'miner';
    }
    if (b.carry > 0) return b.carry >= 1.5 * b.move ? 'laneHauler' : 'hauler';
    return null;
}

/** @param {Creep} creep */
function parts(creep) {
    const out = { work: 0, carry: 0, move: 0, other: 0 };
    for (const p of creep.body) {
        if (p.type === WORK) out.work++;
        else if (p.type === CARRY) out.carry++;
        else if (p.type === MOVE) out.move++;
        else if (p.type !== TOUGH) out.other++;
    }
    return out;
}

/**
 * @param {Creep} creep
 * @param {string[]} mine  my room names
 */
function homeOf(creep, mine) {
    if (mine.indexOf(creep.room.name) !== -1) return creep.room.name;
    let best = null;
    let bestD = Infinity;
    for (const r of mine) {
        const d = Game.map.getRoomLinearDistance(creep.room.name, r);
        if (d < bestD) {
            bestD = d;
            best = r;
        }
    }
    return bestD <= 3 ? best : null;
}

/** @type {import('../../contracts/process').Process & Record<string, any>} */
module.exports = {
    id: 'sense.adopt',
    phase: 'SENSE',
    scope: 'shard',
    tier: 'normal',
    priority: 15,
    run(ctx) {
        const skipped = cache.store('adopt.skipped');
        /** @type {string[]|null} */
        let mine = null;
        let adopted = 0;
        for (const name in Game.creeps) {
            const creep = Game.creeps[name];
            const mem = creep.memory;
            if (mem.h || creep.spawning || skipped[name]) continue;
            if (!mine) mine = ctx.roomList.filter(rc => rc.kind === 'owned').map(rc => rc.name);
            const a = archetype(parts(creep));
            const h = a ? homeOf(creep, mine) : null;
            if (!a || !h) {
                skipped[name] = true;
                continue;
            }
            for (const k of Object.keys(mem)) delete /** @type {any} */ (mem)[k];
            mem.a = a;
            mem.h = h;
            mem.s = 'init';
            adopted++;
        }
        if (adopted > 0) log.info(`[adopt] ${adopted} creep(s) without v2 memory put back to work`);
    },
    archetype,
    parts,
    homeOf
};
