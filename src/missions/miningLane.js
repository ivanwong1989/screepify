// @ts-check
'use strict';

const cache = require('../services/cache');
const laneStore = require('../services/laneStore');
const movement = require('../services/movement');
const traffic = require('../services/traffic');
const roomData = require('../services/roomData');
const policyRules = require('../services/policyRules');
const { CONTINUE, SKIP } = require('../contracts/task');

/**
 * Mining lanes (port of v1 mission.logisticsMiningV2 + role.miningLaneHauler,
 * dev_make_missions_missions).
 *
 * From phase STORAGE (not CRITICAL), every source with a container gets its
 * own haulers on a fixed path from the container to the nearest sink
 * (storage, else a non-mining container):
 *
 *   path      plain 10, swamp 30, road 2, both ends 1; the core lane head
 *             costs 200 (walk around it); tiles next to any source are
 *             blocked (miners stand there)
 *   haulers   CARRY needed = 10 energy/tick × round trip (2 × length + 4,
 *             min 8) / 50; 1–3 haulers of up to max(2, needed / count) CARRY
 *   LOAD      walk the lane back to its start, wait at the container until
 *             full (leave part-full only when TTL ≤ 80)
 *   DELIVER   walk the lane to its end, then into the sink
 *
 * Link sources: when the source has a link within 2 and some other link is
 * away from all sources, one 1-CARRY hauler stands next to both the container
 * and the link and moves energy from one to the other.
 *
 * While a lane has a live hauler, fleet sizing and logistics mining routes
 * leave that source to it (`covered`).
 *
 * Differences from v1: the path is cached on heap with a signature (v1
 * rebuilt every 100 ticks regardless); moves go through services/traffic.
 */

const PLAIN = 10;
const SWAMP = 30;
const ROAD = 2;
const HEAD_AVOID = 200;
const ENERGY_PER_TICK = 10;
const MIN_HAULERS = 1;
const MAX_HAULERS = 3;
const REBUILD_EVERY = 1000;
const EOL_TTL = 80;

/**
 * @typedef {{t: number, sig: string, path: number[], index: Map<number, number>}} MiningPath
 */

/** @param {number} p @param {string} room */
function posOf(p, room) {
    return new RoomPosition(p % 50, (p - (p % 50)) / 50, room);
}

/** @param {import('../contracts/ctx').RoomCtx} rc */
function enabled(rc) {
    const room = rc.room;
    if (!require('../config').get().lanes.mining) return false;
    if (!room.controller || !room.controller.my) return false;
    if (!policyRules.atLeast(rc.policy, 'STORAGE') || (rc.policy && rc.policy.state === 'CRITICAL')) return false;
    return true;
}

/**
 * Nearest sink to the container: storage or a non-mining container (v1 resolveSink).
 * @param {Room} room
 * @param {import('../processes/sense/intel').RoomIntel} intel
 * @param {RoomPosition} from
 */
function sinkFor(room, intel, from) {
    /** @type {any[]} */
    const sinks = room.storage ? [room.storage] : [];
    for (const c of roomData.byType(room, STRUCTURE_CONTAINER)) if (!intel.miningContainerIds.has(c.id)) sinks.push(c);
    let best = null;
    let bestR = Infinity;
    for (const s of sinks) {
        const r = from.getRangeTo(s.pos);
        if (r < bestR) {
            bestR = r;
            best = s;
        }
    }
    return best;
}

/**
 * Source link worth using (v1 hasLinkAssistedSource): a link within 2 of the
 * source and another link that isn't near any source.
 * @param {Room} room
 * @param {import('../processes/sense/intel').SourceIntel} src
 * @param {import('../processes/sense/intel').RoomIntel} intel
 * @returns {StructureLink|null}
 */
function sourceLink(room, src, intel) {
    if (!src.linkId) return null;
    const link = /** @type {StructureLink|null} */ (Game.getObjectById(/** @type {any} */ (src.linkId)));
    if (!link || !link.pos.inRangeTo(src.pos, 2)) return null;
    const receiver = roomData.myByType(room, STRUCTURE_LINK).some(l =>
        l.id !== link.id && !intel.sources.some(s => l.pos.inRangeTo(s.pos, 2)));
    return receiver ? link : null;
}

/**
 * Tile next to both the container and the link with a free neighbour, closest
 * to storage (v1 findLinkOverflowStandPos).
 * @param {Room} room
 * @param {RoomPosition} cpos
 * @param {RoomPosition} lpos
 */
function station(room, cpos, lpos) {
    const terrain = room.getTerrain();
    const blocked = new Set();
    for (const s of roomData.structures(room)) {
        const t = s.structureType;
        if (t !== STRUCTURE_ROAD && t !== STRUCTURE_CONTAINER && !(t === STRUCTURE_RAMPART && /** @type {any} */ (s).my)) {
            blocked.add(s.pos.y * 50 + s.pos.x);
        }
    }
    /** @param {number} x @param {number} y */
    const open = (x, y) => x >= 1 && x <= 48 && y >= 1 && y <= 48 && terrain.get(x, y) !== TERRAIN_MASK_WALL && !blocked.has(y * 50 + x);
    const goal = room.storage ? room.storage.pos : new RoomPosition(25, 25, room.name);
    let best = null;
    let bestR = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            const x = cpos.x + dx;
            const y = cpos.y + dy;
            if ((dx === 0 && dy === 0) || !open(x, y) || Math.max(Math.abs(x - lpos.x), Math.abs(y - lpos.y)) > 1) continue;
            let ingress = false;
            for (let ix = -1; ix <= 1 && !ingress; ix++) {
                for (let iy = -1; iy <= 1; iy++) {
                    const nx = x + ix;
                    const ny = y + iy;
                    if ((ix === 0 && iy === 0) || (nx === cpos.x && ny === cpos.y) || (nx === lpos.x && ny === lpos.y)) continue;
                    if (open(nx, ny)) {
                        ingress = true;
                        break;
                    }
                }
            }
            if (!ingress) continue;
            const r = Math.max(Math.abs(x - goal.x), Math.abs(y - goal.y));
            if (r < bestR) {
                bestR = r;
                best = y * 50 + x;
            }
        }
    }
    return best;
}

/**
 * The lane path from container to sink, cached on heap (v1 buildPath).
 * @param {Room} room
 * @param {RoomPosition} from
 * @param {RoomPosition} to
 * @param {string} key
 * @returns {MiningPath|null}
 */
function lanePath(room, from, to, key) {
    const store = cache.store('mlane.paths');
    const core = laneStore.saved(room.name);
    const head = core && core.p ? core.h : -1;
    const sig = `${from.x},${from.y}|${to.x},${to.y}|${head}|${roomData.structures(room).length}|${roomData.sites(room).length}`;
    const hit = store[key];
    if (hit && hit.sig === sig && Game.time - hit.t < REBUILD_EVERY) return hit.path ? hit : null;

    const terrain = room.getTerrain();
    const m = new PathFinder.CostMatrix();
    for (let y = 0; y < 50; y++) {
        for (let x = 0; x < 50; x++) {
            const t = terrain.get(x, y);
            m.set(x, y, t === TERRAIN_MASK_WALL ? 255 : t === TERRAIN_MASK_SWAMP ? SWAMP : PLAIN);
        }
    }
    for (const s of roomData.structures(room)) {
        const t = s.structureType;
        if (t === STRUCTURE_ROAD) m.set(s.pos.x, s.pos.y, ROAD);
        else if (t !== STRUCTURE_CONTAINER && !(t === STRUCTURE_RAMPART && /** @type {any} */ (s).my)) m.set(s.pos.x, s.pos.y, 255);
    }
    /** @param {number} x @param {number} y */
    const isEnd = (x, y) => (x === from.x && y === from.y) || (x === to.x && y === to.y);
    if (head >= 0) {
        const hx = head % 50;
        const hy = (head - hx) / 50;
        if (!isEnd(hx, hy) && m.get(hx, hy) < 255) m.set(hx, hy, Math.max(m.get(hx, hy), HEAD_AVOID));
    }
    for (const src of roomData.sources(room)) {
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const x = src.pos.x + dx;
                const y = src.pos.y + dy;
                if ((dx || dy) && x >= 1 && x <= 48 && y >= 1 && y <= 48 && !isEnd(x, y)) m.set(x, y, 255);
            }
        }
    }
    m.set(from.x, from.y, 1);
    m.set(to.x, to.y, 1);
    const res = PathFinder.search(from, { pos: to, range: 1 }, {
        maxOps: 4000, plainCost: PLAIN, swampCost: SWAMP,
        roomCallback: (rn) => (rn === room.name ? m : false)
    });
    const ok = res && !res.incomplete && res.path.length > 0;
    const path = ok ? res.path.map(p => p.y * 50 + p.x) : [];
    /** @type {Map<number, number>} */
    const index = new Map();
    path.forEach((p, i) => { if (!index.has(p)) index.set(p, i); });
    const entry = { t: Game.time, sig, path, index };
    store[key] = ok ? entry : { t: Game.time, sig, path: null };
    return ok ? entry : null;
}

/** @param {import('../contracts/ctx').RoomCtx} rc @param {string} id */
function liveCount(rc, id) {
    const t = rc.census && rc.census.byMission[id];
    return t ? t.count : 0;
}

/**
 * Mining containers whose lane has a live hauler (fleet/logistics skip them).
 * @param {import('../contracts/ctx').RoomCtx} rc
 * @returns {Set<string>}
 */
function covered(rc) {
    /** @type {Set<string>} */
    const out = new Set();
    if (!rc.intel || !enabled(rc)) return out;
    for (const s of rc.intel.sources) {
        if (s.containerId && liveCount(rc, `mlane:${s.id}`) > 0) out.add(s.containerId);
    }
    return out;
}

/**
 * @param {import('../contracts/mission').PlanContext} plan
 * @param {import('../contracts/mission').Mission[]} out
 */
function generate(plan, out) {
    const { rc, intel } = plan;
    const room = rc.room;
    if (!enabled(rc)) return;
    const estCarry = Math.max(2, Math.min(25, Math.floor(Math.max(300, intel.energyCapacityAvailable) / 100)));
    for (const src of intel.sources) {
        if (!src.containerId) continue;
        const container = /** @type {StructureContainer|null} */ (Game.getObjectById(/** @type {any} */ (src.containerId)));
        if (!container) continue;
        const id = `mlane:${src.id}`;
        const base = { id, type: 'miningLane', home: room.name, room: room.name, archetype: 'miningHauler', spawn: /** @type {'mission'} */ ('mission'), pos: container.pos, priority: 88 };

        const link = sourceLink(room, src, intel);
        if (link) {
            const st = station(room, container.pos, link.pos);
            out.push(Object.assign(base, {
                demand: { minCreeps: 1, maxCreeps: 1 }, bodyOpts: { maxCarry: 1 },
                data: { mode: 'link', containerId: container.id, linkId: link.id, station: st }
            }));
            continue;
        }
        const sink = sinkFor(room, intel, container.pos);
        if (!sink) continue;
        const lane = lanePath(room, container.pos, sink.pos, src.id);
        const len = lane ? lane.path.length : Math.max(1, container.pos.getRangeTo(sink.pos));
        const roundTrip = Math.max(8, len * 2 + 4);
        const needed = Math.max(1, Math.ceil((ENERGY_PER_TICK * roundTrip) / 50));
        const count = Math.max(MIN_HAULERS, Math.min(MAX_HAULERS, Math.ceil(needed / estCarry)));
        out.push(Object.assign(base, {
            demand: { minCreeps: count, maxCreeps: count },
            bodyOpts: { maxCarry: Math.max(2, Math.ceil(needed / count)) },
            data: { mode: 'lane', containerId: container.id, sinkId: sink.id, sourceId: src.id }
        }));
    }
}

/** @type {import('../contracts/mission').MissionType['nextTask']} */
function nextTask(creep, m) {
    return { a: 'mlane', i: m.id };
}

/** @param {Creep} creep @returns {import('../contracts/mission').Mission|null} */
function missionOf(creep) {
    const planned = cache.store('room.missions')[/** @type {string} */ (creep.memory.h)];
    const id = creep.memory.m;
    return planned && id ? planned.byId[id] || null : null;
}

/**
 * Runs a mining lane hauler for one tick (action 'mlane').
 * @param {Creep} creep
 * @returns {number}
 */
function run(creep) {
    const m = missionOf(creep);
    if (!m || m.type !== 'miningLane') return SKIP;
    const data = /** @type {any} */ (m.data);
    const container = /** @type {StructureContainer|null} */ (Game.getObjectById(data.containerId));
    if (!container) return SKIP;
    if (data.mode === 'link') return runLink(creep, container, data);

    const sink = /** @type {any} */ (Game.getObjectById(data.sinkId));
    const room = creep.room;
    const lane = sink && room.name === m.room ? lanePath(room, container.pos, sink.pos, data.sourceId) : null;
    const mem = /** @type {any} */ (creep.memory);
    const energy = creep.store[RESOURCE_ENERGY] || 0;
    if (!mem.ms || energy === 0) mem.ms = energy === 0 ? 'L' : mem.ms || 'L';
    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) mem.ms = 'D';

    if (mem.ms === 'L') {
        if (energy > 0 && container.store[RESOURCE_ENERGY] === 0 && (creep.ticksToLive || Infinity) <= EOL_TTL) {
            mem.ms = 'D';
            return CONTINUE;
        }
        if (lane && !creep.pos.isNearTo(container)) {
            const idx = lane.index.get(creep.pos.y * 50 + creep.pos.x);
            if (idx === undefined) movement.to(creep, posOf(lane.path[0], room.name), { range: 0 });
            else if (idx > 0) step(creep, lane, idx - 1, room.name);
            else movement.to(creep, container, { range: 1 });
            return CONTINUE;
        }
        if (!creep.pos.isNearTo(container)) {
            movement.to(creep, container, { range: 1 });
            return CONTINUE;
        }
        traffic.working(creep, container.pos, 1);
        if (container.store[RESOURCE_ENERGY] > 0 && creep.withdraw(container, RESOURCE_ENERGY) === OK &&
            container.store[RESOURCE_ENERGY] >= creep.store.getFreeCapacity(RESOURCE_ENERGY)) {
            mem.ms = 'D';
        }
        return CONTINUE;
    }

    // DELIVER
    let target = sink && sink.store.getFreeCapacity(RESOURCE_ENERGY) > 0 ? sink : room.storage;
    if (!target || target.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return CONTINUE;
    if (creep.pos.isNearTo(target)) {
        creep.transfer(target, RESOURCE_ENERGY);
        mem.ms = 'L';
        return CONTINUE;
    }
    if (lane && target === sink) {
        const idx = lane.index.get(creep.pos.y * 50 + creep.pos.x);
        const end = lane.path.length - 1;
        if (idx !== undefined && idx < end) {
            step(creep, lane, idx + 1, room.name);
            return CONTINUE;
        }
    }
    movement.to(creep, target, { range: 1 });
    return CONTINUE;
}

/** @param {Creep} creep @param {MiningPath} lane @param {number} i @param {string} roomName */
function step(creep, lane, i, roomName) {
    const p = posOf(lane.path[i], roomName);
    traffic.register(creep, creep.pos.getDirectionTo(p));
}

/**
 * Link source: container → link from a tile next to both (v1 link overflow).
 * @param {Creep} creep
 * @param {StructureContainer} container
 * @param {any} data
 */
function runLink(creep, container, data) {
    const link = /** @type {StructureLink|null} */ (Game.getObjectById(data.linkId));
    if (!link) return SKIP;
    if (Number.isFinite(data.station)) {
        const st = posOf(data.station, container.pos.roomName);
        if (!creep.pos.isEqualTo(st)) {
            movement.to(creep, st, { range: 0 });
            return CONTINUE;
        }
        traffic.pin(creep);
    } else if (!creep.pos.isNearTo(container) || !creep.pos.isNearTo(link)) {
        movement.to(creep, creep.pos.isNearTo(container) ? link : container, { range: 1 });
        return CONTINUE;
    }
    if ((creep.store[RESOURCE_ENERGY] || 0) > 0 && link.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        creep.transfer(link, RESOURCE_ENERGY);
    } else if (container.store[RESOURCE_ENERGY] > 0 && creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        creep.withdraw(container, RESOURCE_ENERGY);
    }
    return CONTINUE;
}

module.exports = { type: 'miningLane', generate, nextTask, run, covered, lanePath, sourceLink, station };
