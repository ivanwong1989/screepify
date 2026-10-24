// @ts-check
'use strict';

const cache = require('../services/cache');
const haulDemand = require('../services/haulDemand');
const roomData = require('../services/roomData');
const laneClaims = require('../services/laneClaims');

/** Ticks after the last off-lane hauling job that the fleet keeps a hauler. */
const DEMAND_WINDOW = 300;

/**
 * Hauler fleet sizing (port of v1 mission.fleet_logistic).
 *
 * Spawn-only mission: sets how many haulers the room keeps. Haulers never
 * stay assigned to it; they pick up supply/haul missions instead.
 *
 * Carry needed per efficient source ≈ 10 energy/tick × round trip / 50,
 * with a floor of 5 CARRY (3 for sources that have a link to a receiver).
 */

const MAX_HAULER_CARRY_PARTS = 25;
const MIN_CARRY_PER_SOURCE = 5;
const LINKED_SOURCE_MIN_CARRY = 3;
const ENERGY_PER_TICK = 10;
const TRANSFER_BUFFER_TICKS = 2;
const DISTANCE_SOFT_CAP = 17;
const DISTANCE_SCALE_PER_TILE = 0.1;
const EARLY_GAME_ENERGY_CAP = 500;
const EARLY_GAME_HAULER_MULTIPLIER = 1.01;

/**
 * Path length between two positions, cached per room on heap until the
 * drop-off target changes.
 * @param {string} roomName
 * @param {string} signature
 * @param {string} key
 * @param {() => number} compute
 */
function cachedLength(roomName, signature, key, compute) {
    const root = cache.store('fleet.paths');
    let entry = root[roomName];
    if (!entry || entry.sig !== signature) entry = root[roomName] = { sig: signature, paths: Object.create(null) };
    if (entry.paths[key] === undefined) entry.paths[key] = compute();
    return entry.paths[key];
}

/**
 * @param {RoomPosition} from
 * @param {RoomPosition} to
 */
function pathLength(from, to) {
    const ret = PathFinder.search(from, { pos: to, range: 1 }, { maxOps: 2000, plainCost: 2, swampCost: 10 });
    return ret.incomplete ? from.getRangeTo(to) : ret.path.length;
}

/**
 * Minimum fleet haulers.
 * @param {boolean} lanes          mining lanes cover at least one source
 * @param {number} fleetSources    efficient sources the fleet still hauls for
 * @param {number} efficient       efficient sources in the room
 * @param {boolean} offLaneWork    off-lane hauling work recently, or hostiles around
 */
function floor(lanes, fleetSources, efficient, offLaneWork) {
    if (!lanes) return Math.max(2, efficient);
    return Math.max(offLaneWork ? 1 : 0, fleetSources);
}

/**
 * @param {import('../contracts/mission').PlanContext} plan
 * @param {import('../contracts/mission').Mission[]} out
 */
function generate(plan, out) {
    const { rc, intel, budget, efficientSources } = plan;
    if (efficientSources.size === 0) return;
    const room = rc.room;
    const storage = room.storage;
    const spawns = roomData.myByType(room, STRUCTURE_SPAWN);
    const targets = storage ? [storage] : spawns;
    if (targets.length === 0) return;

    const carryParts = Math.min(Math.max(1, Math.floor((budget || 0) / 100)), MAX_HAULER_CARRY_PARTS);
    const links = roomData.myByType(room, STRUCTURE_LINK);
    const hasReceiver = links.some(l =>
        (storage && l.pos.inRangeTo(storage.pos, 3)) || spawns.some(s => l.pos.inRangeTo(s.pos, 3)));
    const signature = storage ? `storage:${storage.id}` : `spawns:${spawns.map(s => s.id).sort().join(',')}`;

    // Sources whose mining lane has a live hauler need no fleet carry.
    const laneContainers = laneClaims.of(rc).mining;
    let required = 0;
    let fleetSources = 0;
    for (const source of intel.sources) {
        if (!efficientSources.has(source.id)) continue;
        if (source.containerId && laneContainers.has(source.containerId)) continue;
        fleetSources++;
        const linked = hasReceiver && links.some(l => l.pos.inRangeTo(source.pos, 2));
        let need = LINKED_SOURCE_MIN_CARRY;
        if (!linked) {
            const container = source.containerId ? /** @type {any} */ (Game.getObjectById(/** @type {any} */ (source.containerId))) : null;
            const pickup = container ? container.pos : source.pos;
            const pickupId = container ? container.id : source.id;
            const len = cachedLength(room.name, signature, pickupId, () => {
                let best = Infinity;
                for (const t of targets) best = Math.min(best, pathLength(pickup, t.pos));
                return Number.isFinite(best) ? best : 1;
            });
            const roundTrip = len * 2 + TRANSFER_BUFFER_TICKS;
            const scale = 1 + Math.max(0, len - DISTANCE_SOFT_CAP) * DISTANCE_SCALE_PER_TILE;
            need = Math.ceil((ENERGY_PER_TICK * roundTrip * scale) / 50);
        }
        required += Math.max(linked ? LINKED_SOURCE_MIN_CARRY : MIN_CARRY_PER_SOURCE, need);
    }

    const early = (room.controller && room.controller.level < 2) ||
        (!storage && intel.energyCapacityAvailable <= EARLY_GAME_ENERGY_CAP);
    const scaled = early ? Math.ceil(required * EARLY_GAME_HAULER_MULTIPLIER) : required;
    // With mining lanes running, the fleet only refills off-lane structures
    // and scavenges: one hauler is the floor, but only while there has been
    // such work in the last DEMAND_WINDOW ticks or hostiles are around
    // (services/haulDemand). Otherwise the last one isn't replaced when it
    // dies; new demand brings the floor back at once.
    const minHaulers = floor(laneContainers.size > 0, fleetSources, efficientSources.size,
        haulDemand.recent(room.name, DEMAND_WINDOW) || intel.hostiles.length > 0);
    const desired = Math.max(minHaulers, Math.ceil(scaled / carryParts));

    out.push({
        id: 'logistics:fleet',
        type: 'hauler_fleet',
        home: room.name,
        room: room.name,
        archetype: 'hauler',
        demand: { carry: scaled, minCreeps: minHaulers, maxCreeps: desired },
        spawn: 'pool',
        bodyOpts: { maxCarry: MAX_HAULER_CARRY_PARTS },
        priority: 85
    });
}

module.exports = { type: 'hauler_fleet', generate, floor, spawnOnly: true };
