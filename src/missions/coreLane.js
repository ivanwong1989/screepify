// @ts-check
'use strict';

const laneStore = require('../services/laneStore');
const laneClaims = require('../services/laneClaims');
const movement = require('../services/movement');
const traffic = require('../services/traffic');
const roomData = require('../services/roomData');
const { CONTINUE, SKIP } = require('../contracts/task');

/**
 * Core lane hauler (port of v1 mission.logisticsCoreV2 + role.coreLaneHauler,
 * dev_make_missions_missions).
 *
 * One hauler per room walks the core lane (services/lanes, built by
 * plan.lanes) and fills every spawn/extension/tower next to it:
 *
 *   LOAD     at the head (lane index 0): withdraw energy from storage (or the
 *            head link) when anything on the lane needs energy; otherwise park
 *            at the head, drain the head link into storage, and renew at an
 *            adjacent spawn when TTL < 1100 (until 1450).
 *   DELIVER  step along the lane; at each index fill the stop with the most
 *            free capacity. Linear lane: walk to the end. Loop: go to the
 *            nearest index with demand, either direction.
 *   RETURN   step back to the head, put leftover cargo in storage, then LOAD.
 *
 * Creep memory: ls = state ('L'|'D'|'R'), ld = loop direction, lr = renewing.
 *
 * Not ported yet: v1's side jobs on the lane (terminal stock P11, labs P12,
 * and off-lane "core service" refills, which v2's logistics supply missions
 * already cover).
 *
 * Differences from v1:
 * - The lane mission stays up in CRITICAL while a lane hauler is alive (it is
 *   the fastest way to refill spawns from storage); only spawning a new one waits.
 * - After filling a stop that this transfer satisfies, the hauler steps on in
 *   the same tick instead of waiting one tick per stop.
 * - Lane-local yield/swap logic is replaced by services/traffic.
 */

const MISSION_ID = 'coreLane';
const RENEW_START = 1100;
const RENEW_STOP = 1450;

/** Road hauler CARRY parts for this room (v1: 2 CARRY per MOVE, ≤ 33). @param {Room} room */
function intendedCarry(room) {
    return Math.max(1, Math.min(33, Math.floor((room.energyCapacityAvailable * 2) / 150)));
}

/**
 * @param {import('../contracts/mission').PlanContext} plan
 * @param {import('../contracts/mission').Mission[]} out
 */
function generate(plan, out) {
    const { rc, ctx, policy } = plan;
    const room = rc.room;
    if (!ctx.config.lanes.enabled || !room.storage) return;
    const lane = laneStore.get(room);
    if (!lane) return;
    const live = laneClaims.coreHaulers(rc);
    if (live.length === 0 && policy && policy.state === 'CRITICAL') return;
    const carry = intendedCarry(room);
    // A bootstrap-sized hauler (under half the CARRY the room can afford) gets
    // a full-size replacement; it retires once that one is out (see run()).
    const undersized = live.length > 0 && live.every(c => c.getActiveBodyparts(CARRY) * 2 < carry);
    const want = undersized ? 2 : 1;
    out.push({
        id: MISSION_ID, type: 'coreLane', home: room.name, room: room.name, archetype: 'laneHauler',
        demand: { minCreeps: want, maxCreeps: want }, spawn: 'mission',
        bodyOpts: { maxCarry: carry },
        pos: posOf(room.name, lane.head),
        data: { carry },
        priority: 92
    });
}

/** @param {string} roomName @param {number} p */
function posOf(roomName, p) {
    return new RoomPosition(p % 50, (p - (p % 50)) / 50, roomName);
}

/** @type {import('../contracts/mission').MissionType['nextTask']} */
function nextTask(creep, m) {
    const room = Game.rooms[m.room];
    if (!room || !laneStore.get(room)) return null;
    return { a: 'lane', i: m.id };
}

/**
 * Whether the stop at a lane index (or any stop) still wants energy.
 * @param {laneStore.Lane} lane
 * @param {number|null} idx   null = whole lane
 * @param {{ignoreSpawn?: boolean, filled?: Set<string>}} [opts]
 * @returns {any|null} a target with demand at that index (most free first), or null
 */
function demandAt(lane, idx, opts) {
    const o = opts || {};
    const keys = idx === null ? Object.keys(lane.stops) : [String(idx)];
    let best = null;
    let bestFree = 0;
    for (const k of keys) {
        for (const id of lane.stops[/** @type {any} */ (k)] || []) {
            if (o.filled && o.filled.has(id)) continue;
            const t = /** @type {any} */ (Game.getObjectById(/** @type {any} */ (id)));
            if (!t || !t.store) continue;
            if (o.ignoreSpawn && t.structureType === STRUCTURE_SPAWN) continue;
            const free = t.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
            if (free > bestFree) {
                bestFree = free;
                best = t;
                if (idx === null) return best;
            }
        }
    }
    return best;
}

/** @param {Creep} creep @param {laneStore.Lane} lane */
function indexOf(creep, lane) {
    const i = lane.index.get(creep.pos.y * 50 + creep.pos.x);
    return i === undefined ? -1 : i;
}

/**
 * One step along the lane toward `target` (shortest way round on a loop).
 * Off the lane: walk to the nearest lane tile, preferring tiles near `target`.
 * @param {Creep} creep
 * @param {laneStore.Lane} lane
 * @param {number} target
 */
function stepToward(creep, lane, target) {
    const n = lane.path.length;
    const cur = indexOf(creep, lane);
    if (cur < 0) {
        const near = [0, 1, -1, 2, -2, 3, -3].map(o => (lane.loop ? ((target + o) % n + n) % n : target + o))
            .filter(i => i >= 0 && i < n);
        const cands = near.length ? near : lane.path.map((_, i) => i);
        let best = lane.path[cands[0]];
        let bestR = Infinity;
        for (const i of cands) {
            const p = lane.path[i];
            const r = Math.max(Math.abs(p % 50 - creep.pos.x), Math.abs((p - (p % 50)) / 50 - creep.pos.y));
            if (r < bestR) {
                bestR = r;
                best = p;
            }
        }
        movement.to(creep, posOf(creep.room.name, best), { range: 0 });
        return;
    }
    if (cur === target) return;
    let next;
    if (lane.loop) {
        const fwd = ((target - cur) % n + n) % n;
        const rev = ((cur - target) % n + n) % n;
        const mem = /** @type {any} */ (creep.memory);
        const dir = fwd < rev ? 1 : rev < fwd ? -1 : (mem.ld === -1 ? -1 : 1);
        mem.ld = dir;
        next = lane.path[((cur + dir) % n + n) % n];
    } else {
        next = lane.path[cur < target ? cur + 1 : cur - 1];
    }
    traffic.register(creep, creep.pos.getDirectionTo(next % 50, (next - (next % 50)) / 50));
}

/** Nearest lane index with demand (loop: either way round). @param {Creep} creep @param {laneStore.Lane} lane @param {any} opts */
function nearestDemand(creep, lane, opts) {
    const cur = indexOf(creep, lane);
    const n = lane.path.length;
    let best = -1;
    let bestD = Infinity;
    for (const k of Object.keys(lane.stops)) {
        const i = Number(k);
        if (!demandAt(lane, i, opts)) continue;
        const d = lane.loop ? Math.min(((i - cur) % n + n) % n, ((cur - i) % n + n) % n) : Math.abs(i - cur);
        if (d < bestD) {
            bestD = d;
            best = i;
        }
    }
    return best;
}

/** Puts cargo other than `keep` into storage. Returns true if that used the tick. @param {Creep} creep @param {string|null} keep */
function dumpCargo(creep, keep) {
    const storage = creep.room.storage;
    for (const rt in creep.store) {
        if ((creep.store[/** @type {ResourceConstant} */ (rt)] || 0) <= 0 || rt === keep) continue;
        const target = storage && storage.store.getFreeCapacity(/** @type {ResourceConstant} */ (rt)) > 0 ? storage : creep.room.terminal;
        if (!target) continue;
        if (!creep.pos.isNearTo(target)) movement.to(creep, target, { range: 1 });
        else creep.transfer(target, /** @type {ResourceConstant} */ (rt));
        return true;
    }
    return false;
}

/** Link next to the head and within 2 of storage that has energy (v1 head drain link). @param {Room} room @param {laneStore.Lane} lane */
function headLink(room, lane) {
    const storage = room.storage;
    if (!storage) return null;
    const hx = lane.head % 50;
    const hy = (lane.head - hx) / 50;
    let best = null;
    for (const l of roomData.myByType(room, STRUCTURE_LINK)) {
        if ((l.store[RESOURCE_ENERGY] || 0) <= 0) continue;
        if (l.pos.getRangeTo(storage) > 2 || Math.max(Math.abs(l.pos.x - hx), Math.abs(l.pos.y - hy)) > 1) continue;
        if (!best || l.store[RESOURCE_ENERGY] > best.store[RESOURCE_ENERGY]) best = l;
    }
    return best;
}

/** @param {Creep} creep */
function adjacentSpawn(creep) {
    return roomData.myByType(creep.room, STRUCTURE_SPAWN).find(s => !s.spawning && creep.pos.isNearTo(s)) || null;
}

/**
 * Renew conditions (v1): TTL below 1100 (or already renewing, until 1450),
 * the body is the size this room would spawn now, empty, parked at the head.
 * @param {Creep} creep
 * @param {laneStore.Lane} lane
 */
function wantsRenew(creep, lane) {
    const mem = /** @type {any} */ (creep.memory);
    const ttl = creep.ticksToLive;
    if (!Number.isFinite(ttl) || /** @type {number} */ (ttl) >= RENEW_STOP) {
        delete mem.lr;
        return false;
    }
    if (!mem.lr && /** @type {number} */ (ttl) > RENEW_START) return false;
    if (creep.getActiveBodyparts(CARRY) !== intendedCarry(creep.room)) {
        delete mem.lr;
        return false;
    }
    return (mem.ls || 'L') === 'L' && creep.store.getUsedCapacity() === 0 && indexOf(creep, lane) === 0 && !!adjacentSpawn(creep);
}

/**
 * A smaller lane hauler steps down once a bigger one is working: it puts its
 * cargo in storage and suicides (v2 has no recycling yet).
 * @param {Creep} creep
 */
function retire(creep) {
    const mine = creep.getActiveBodyparts(CARRY);
    const bigger = Object.values(Game.creeps).some(c => c !== creep && !c.spawning && c.memory.a === 'laneHauler' &&
        c.memory.h === creep.memory.h && c.getActiveBodyparts(CARRY) > mine);
    if (!bigger) return false;
    if (dumpCargo(creep, null)) return true;
    creep.suicide();
    return true;
}

/**
 * Runs the lane hauler for one tick (action 'lane').
 * @param {Creep} creep
 * @returns {number}
 */
function run(creep) {
    const room = creep.room;
    const lane = room.name === creep.memory.h ? laneStore.get(room) : null;
    if (!lane) {
        const home = Game.rooms[/** @type {string} */ (creep.memory.h)];
        if (!home || !laneStore.get(home)) return SKIP;
        movement.to(creep, home.storage || new RoomPosition(25, 25, home.name), { range: 1 });
        return CONTINUE;
    }
    const mem = /** @type {any} */ (creep.memory);
    if (retire(creep)) return CONTINUE;
    if (!mem.ls) mem.ls = 'L';
    if (creep.store.getUsedCapacity() === 0 && mem.ls !== 'R') mem.ls = 'L';
    const renewing = wantsRenew(creep, lane);
    const opts = { ignoreSpawn: renewing };
    const anyDemand = !!demandAt(lane, null, opts);

    if (mem.ls === 'L') {
        if (renewing && !anyDemand) {
            const spawn = adjacentSpawn(creep);
            const r = spawn ? spawn.renewCreep(creep) : ERR_NOT_IN_RANGE;
            if (r === OK) mem.lr = 1;
            else delete mem.lr;
            if (r === OK) return CONTINUE;
        }
        if (anyDemand) {
            if (dumpCargo(creep, RESOURCE_ENERGY)) return CONTINUE;
            if ((creep.store[RESOURCE_ENERGY] || 0) > 0) {
                mem.ls = 'D';
                return deliver(creep, lane, opts);
            }
            if (indexOf(creep, lane) !== 0) {
                stepToward(creep, lane, 0);
                return CONTINUE;
            }
            traffic.working(creep, posOf(room.name, lane.head), 0);
            const storage = room.storage;
            const src = storage && storage.store[RESOURCE_ENERGY] > 0 ? storage : headLink(room, lane);
            if (src && creep.withdraw(/** @type {any} */ (src), RESOURCE_ENERGY) === OK) {
                mem.ls = 'D';
                // Start walking now (the energy arrives at the end of this tick),
                // unless a stop at the head itself needs it.
                const t = lane.loop ? nearestDemand(creep, lane, opts) : lane.path.length - 1;
                // (spawn included: it is only ignored while deciding to renew).
                if (t > 0 && !demandAt(lane, 0)) stepToward(creep, lane, t);
            }
            return CONTINUE;
        }
        // Idle: park at the head, keep the head link drained into storage.
        if (indexOf(creep, lane) !== 0) {
            if (dumpCargo(creep, RESOURCE_ENERGY)) return CONTINUE;
            stepToward(creep, lane, 0);
            return CONTINUE;
        }
        traffic.working(creep, posOf(room.name, lane.head), 0);
        const storage = room.storage;
        if (storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            if ((creep.store[RESOURCE_ENERGY] || 0) > 0) {
                if (creep.pos.isNearTo(storage)) creep.transfer(storage, RESOURCE_ENERGY);
                return CONTINUE;
            }
            const link = headLink(room, lane);
            if (link && creep.pos.isNearTo(link)) creep.withdraw(link, RESOURCE_ENERGY);
        }
        dumpCargo(creep, RESOURCE_ENERGY);
        return CONTINUE;
    }
    if (mem.ls === 'D') return deliver(creep, lane, opts);

    // RETURN
    if (indexOf(creep, lane) !== 0) {
        stepToward(creep, lane, 0);
        return CONTINUE;
    }
    if (dumpCargo(creep, null)) return CONTINUE;
    mem.ls = 'L';
    return CONTINUE;
}

/**
 * DELIVER: fill the stop here, else move to the next stop with demand.
 * @param {Creep} creep
 * @param {laneStore.Lane} lane
 * @param {{ignoreSpawn?: boolean}} opts
 */
function deliver(creep, lane, opts) {
    const mem = /** @type {any} */ (creep.memory);
    let energy = creep.store[RESOURCE_ENERGY] || 0;
    if (energy <= 0 || !demandAt(lane, null, opts)) {
        mem.ls = 'R';
        stepToward(creep, lane, 0);
        return CONTINUE;
    }
    const idx = indexOf(creep, lane);
    if (idx < 0) {
        stepToward(creep, lane, lane.loop ? 1 : 0);
        return CONTINUE;
    }
    /** @type {Set<string>} */
    const filled = new Set();
    const here = demandAt(lane, idx, opts);
    if (here) {
        const free = here.store.getFreeCapacity(RESOURCE_ENERGY);
        creep.transfer(here, RESOURCE_ENERGY);
        if (energy < free) return CONTINUE;
        energy -= free;
        filled.add(here.id);
        if (energy <= 0) {
            mem.ls = 'R';
            stepToward(creep, lane, 0);
            return CONTINUE;
        }
        // Satisfied this stop; step on this tick if nothing else here needs energy.
        if (demandAt(lane, idx, Object.assign({ filled }, opts))) return CONTINUE;
    }
    const nextOpts = Object.assign({ filled }, opts);
    if (!lane.loop) {
        const end = lane.path.length - 1;
        if (idx >= end || !demandAt(lane, null, nextOpts)) {
            mem.ls = 'R';
            stepToward(creep, lane, 0);
            return CONTINUE;
        }
        stepToward(creep, lane, end);
        return CONTINUE;
    }
    const target = nearestDemand(creep, lane, nextOpts);
    if (target < 0) {
        mem.ls = 'R';
        stepToward(creep, lane, 0);
        return CONTINUE;
    }
    stepToward(creep, lane, target);
    return CONTINUE;
}

module.exports = { type: 'coreLane', generate, nextTask, run, intendedCarry, demandAt, MISSION_ID };
