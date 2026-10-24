// @ts-check
'use strict';

const body = require('../../services/body');
const missionMarks = require('../../services/missionMarks');
const log = require('../../services/log');
const roomData = require('../../services/roomData');

/**
 * Spawning (port of v1 spawn.contracts + spawn.census + spawn.planner + the
 * local part of the global spawner), without Memory.spawnTickets: a creep's
 * memory says which contract it fills, so the census is the source of truth.
 *
 * Contracts from missions (DESIGN §10):
 *   pool    'pool:<archetype>'  headcounts of all pool missions added up
 *   slots   one per slot key    (harvest positions)
 *   mission '<mission id>'
 *
 * A miner or hauler about to die (ttl ≤ body×3 + lead + spawn busy time) no
 * longer counts, so its replacement is spawned in time.
 *
 * Picks the highest-priority unmet contract (after 5 of the same archetype in
 * a row, prefers another one), then spawns at full capacity — or with what's
 * available when bootstrapping, in an emergency, or after waiting 100 ticks.
 */

const NEAR_DEATH_BUFFER = 20;
const GRACE_PERIOD = 100;
const MAX_CONSECUTIVE = 5;

/**
 * @typedef {Object} Contract
 * @property {string} key
 * @property {string} archetype
 * @property {number} desired
 * @property {number} priority
 * @property {number} lead
 * @property {import('../../contracts/mission').Mission} mission  representative mission
 * @property {'pool'|'slots'|'mission'} mode
 */

/** Archetypes that carry energy for the room (any of them counts as "has haulers"). */
const HAULERS = new Set(['hauler', 'miningHauler', 'laneHauler']);

/**
 * v1 getDesiredCount.
 * @param {import('../../contracts/mission').Mission} m
 * @param {number} capacity
 */
function desiredCount(m, capacity) {
    const d = m.demand;
    const min = Math.max(0, d.minCreeps || 0);
    const max = Number.isFinite(d.maxCreeps) ? Math.max(0, /** @type {number} */ (d.maxCreeps)) : Infinity;
    let desired = min;
    if ((d.work || 0) > 0 || (d.carry || 0) > 0 || (d.claim || 0) > 0) {
        const s = body.stats(/** @type {string} */ (m.archetype), capacity, m.bodyOpts);
        const byWork = d.work ? Math.ceil(d.work / Math.max(1, s.work)) : 0;
        const byCarry = d.carry ? Math.ceil(d.carry / Math.max(1, s.carry)) : 0;
        const byClaim = d.claim ? Math.ceil(d.claim / Math.max(1, s.claim)) : 0;
        desired = Math.max(min, byWork, byCarry, byClaim);
    }
    return Math.max(0, Math.min(desired, max));
}

/**
 * @param {import('../../contracts/mission').Mission[]} missions
 * @param {number} capacity
 * @returns {Contract[]}
 */
function contracts(missions, capacity) {
    /** @type {Record<string, Contract>} */
    const byKey = {};
    /** @type {Contract[]} */
    const list = [];
    /** @param {Contract} c */
    const add = (c) => {
        const ex = byKey[c.key];
        if (!ex) {
            byKey[c.key] = c;
            list.push(c);
            return;
        }
        ex.desired += c.desired;
        if (c.priority > ex.priority) ex.priority = c.priority;
        if (c.lead > ex.lead) ex.lead = c.lead;
    };
    for (const m of missions) {
        if (!m.spawn || !m.archetype) continue;
        // Found finished by its creeps: no spawning for it (services/missionMarks).
        if (missionMarks.isFinished(m)) continue;
        const desired = desiredCount(m, capacity);
        const base = { archetype: m.archetype, priority: m.priority || 0, lead: m.leadTicks || 0, mission: m };
        if (m.spawn === 'pool') {
            add(Object.assign({ key: `pool:${m.archetype}`, desired, mode: /** @type {'pool'} */ ('pool') }, base));
        } else if (m.spawn === 'slots') {
            for (const slot of (m.slots || []).slice(0, desired)) {
                add(Object.assign({ key: slot, desired: 1, mode: /** @type {'slots'} */ ('slots') }, base));
            }
        } else {
            add(Object.assign({ key: m.id, desired, mode: /** @type {'mission'} */ ('mission') }, base));
        }
    }
    return list;
}

/**
 * Shortest remaining spawn time among busy spawns (0 if any is idle or none busy).
 * @param {StructureSpawn[]} spawns
 */
function spawnBusyTicks(spawns) {
    let min = Infinity;
    for (const s of spawns) {
        if (s.spawning && s.spawning.remainingTime > 0 && s.spawning.remainingTime < min) min = s.spawning.remainingTime;
    }
    return Number.isFinite(min) ? min : 0;
}

/**
 * @param {Creep} creep
 * @param {number} lead
 * @param {number} busy
 */
function nearDeath(creep, lead, busy) {
    const a = creep.memory.a;
    if (a !== 'miner' && a !== 'hauler' && a !== 'miningHauler') return false;
    if (!Number.isFinite(creep.ticksToLive)) return false;
    return /** @type {number} */ (creep.ticksToLive) <= creep.body.length * CREEP_SPAWN_TIME + (lead || NEAR_DEATH_BUFFER) + busy;
}

/**
 * Binds creeps that work a slot/mission contract's mission but carry no
 * binding (adopted after a Memory wipe, or reassigned) to a free contract of
 * that mission, so they count and no duplicate is spawned.
 * @param {Contract[]} list
 * @param {Creep[]} creeps
 */
function bindStrays(list, creeps) {
    /** @type {Record<string, Contract[]>} */
    const byMission = {};
    /** @type {Set<string>} */
    const keys = new Set();
    for (const c of list) {
        keys.add(c.key);
        if (c.mode === 'pool') continue;
        (byMission[c.mission.id] || (byMission[c.mission.id] = [])).push(c);
    }
    /** @type {Record<string, number>} */
    const taken = {};
    for (const creep of creeps) if (creep.memory.b && keys.has(creep.memory.b)) taken[creep.memory.b] = (taken[creep.memory.b] || 0) + 1;
    for (const creep of creeps) {
        const mem = creep.memory;
        if ((mem.b && keys.has(mem.b)) || !mem.m || !byMission[mem.m]) continue;
        if (byMission[mem.m].some(c => c.archetype !== mem.a)) continue;
        const free = byMission[mem.m].find(c => (taken[c.key] || 0) < c.desired);
        if (!free) continue;
        mem.b = free.key;
        taken[free.key] = (taken[free.key] || 0) + 1;
    }
}

/**
 * @param {Contract[]} list
 * @param {Creep[]} creeps  home creeps incl. spawning
 * @param {number} busy
 * @returns {Record<string, number>}
 */
function fulfillment(list, creeps, busy) {
    /** @type {Record<string, Contract>} */
    const byKey = {};
    /** @type {Record<string, number>} */
    const counts = {};
    for (const c of list) {
        byKey[c.key] = c;
        counts[c.key] = 0;
    }
    for (const creep of creeps) {
        const b = creep.memory.b;
        let c = b ? byKey[b] : undefined;
        if (!c) c = byKey[`pool:${creep.memory.a}`];
        if (!c) continue;
        if (nearDeath(creep, c.lead, busy)) continue;
        counts[c.key]++;
    }
    return counts;
}

/**
 * v1 selectContract: highest priority, but not 6 of one archetype in a row.
 * @param {Contract[]} unmet  sorted by priority
 * @param {string[]} history
 */
function select(unmet, history) {
    if (history.length >= MAX_CONSECUTIVE) {
        const last = history[history.length - 1];
        let streak = 0;
        for (let i = history.length - 1; i >= 0 && history[i] === last; i--) streak++;
        if (streak >= MAX_CONSECUTIVE) {
            const alt = unmet.find(c => c.archetype !== last);
            if (alt) return alt;
        }
    }
    return unmet[0];
}

/**
 * v1 computeBudget.
 * @param {import('../../contracts/ctx').RoomCtx} rc
 * @param {any} mem  room spawner memory
 * @param {string} contractKey
 */
function budget(rc, mem, contractKey) {
    const room = rc.room;
    const cap = room.energyCapacityAvailable;
    const avail = room.energyAvailable;
    const active = rc.census ? rc.census.active : [];
    const hasMiners = active.some(c => c.memory.a === 'miner');
    const hasHaulers = active.some(c => HAULERS.has(/** @type {string} */ (c.memory.a)));
    // v1: the first lane hauler is sized from the energy there is now. A
    // replacement waits for full size; the current one keeps the lane filled.
    if (contractKey === 'coreLane') return active.some(c => c.memory.a === 'laneHauler') ? cap : Math.max(avail, 100);
    if (mem.last !== contractKey) {
        mem.last = contractKey;
        mem.wait = 0;
    }
    if (!hasMiners || !hasHaulers || (rc.state && rc.state.op === 'EMERGENCY')) {
        mem.wait = 0;
        return Math.max(avail, 200);
    }
    if (avail < cap) {
        mem.wait = (mem.wait || 0) + 1;
        return mem.wait > GRACE_PERIOD ? Math.max(avail, 200) : cap;
    }
    mem.wait = 0;
    return cap;
}

/**
 * @param {import('../../contracts/ctx').TickContext} ctx
 * @param {import('../../contracts/ctx').RoomCtx} rc
 */
function run(ctx, rc) {
    const room = rc.room;
    const spawns = roomData.myByType(room, STRUCTURE_SPAWN);
    const idle = spawns.filter(s => !s.spawning);
    if (idle.length === 0 || !rc.missions || !rc.census) return;

    const list = contracts(rc.missions, room.energyCapacityAvailable);
    if (list.length === 0) return;
    bindStrays(list, rc.census.creeps);
    const counts = fulfillment(list, rc.census.creeps, spawnBusyTicks(spawns));
    const roomMem = /** @type {any} */ (Memory.rooms[room.name] || (Memory.rooms[room.name] = {}));
    const mem = roomMem.sp || (roomMem.sp = { hist: [] });
    let energy = room.energyAvailable;

    for (const spawn of idle) {
        const unmet = list
            .map((c, i) => ({ c, i }))
            .filter(e => counts[e.c.key] < e.c.desired)
            .sort((a, b) => (b.c.priority - a.c.priority) || (a.i - b.i))
            .map(e => e.c);
        if (unmet.length === 0) return;
        const pick = select(unmet, mem.hist);
        const b = budget(rc, mem, pick.key);
        const stats = body.stats(pick.archetype, b, pick.mission.bodyOpts);
        if (stats.cost > energy) return; // wait for energy (v1: no partial spawn while waiting)

        const name = `${pick.archetype}_${Game.time.toString(36)}_${Math.floor(Math.random() * 100)}`;
        /** @type {CreepMemory} */
        const memory = /** @type {any} */ ({ a: pick.archetype, h: room.name, s: 'init' });
        if (pick.mode !== 'pool') {
            memory.b = pick.key;
            memory.m = pick.mission.id;
        }
        const r = spawn.spawnCreep(stats.body.slice(), name, { memory });
        if (r !== OK) {
            log.debug('spawner', `${room.name} spawn ${pick.key} failed: ${r}`);
            return;
        }
        // Always logged: spawns are rare, and "why was this spawned?" is the
        // first question when a creep turns out idle.
        const why = /** @type {any} */ (pick.mission.data || {}).why;
        log.info(`[spawn] ${room.name} ${name} for ${pick.key} (have ${counts[pick.key]}, want ${pick.desired}; ` +
            `mission ${pick.mission.id} prio ${pick.priority}, ${stats.body.length} parts, ${stats.cost} energy)${why ? ` — ${why}` : ''}`);
        energy -= stats.cost;
        counts[pick.key]++;
        mem.hist.push(pick.archetype);
        if (mem.hist.length > MAX_CONSECUTIVE) mem.hist.shift();
        mem.wait = 0;
    }
}

/** @type {import('../../contracts/process').Process & Record<string, any>} */
module.exports = {
    id: 'act.spawns',
    phase: 'ACT',
    scope: 'room',
    kinds: ['owned', 'bootstrap'],
    tier: 'critical',
    priority: 10,
    run,
    contracts,
    fulfillment,
    bindStrays,
    desiredCount,
    select,
    budget
};
