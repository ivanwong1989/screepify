// @ts-check
'use strict';

const cache = require('./cache');
const roomData = require('./roomData');
const { pack, unpack } = require('./pos');

/** Birth bindings are spawn accounting, not ownership of a physical working tile. */
const HANDOFF_TTL = 30;

/** @param {Room} room @param {RoomPosition} pos */
function walkable(room, pos) {
    if (pos.x < 1 || pos.x > 48 || pos.y < 1 || pos.y > 48 || room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_WALL) return false;
    if (roomData.sources(room).some(s => s.pos.isEqualTo(pos))) return false;
    return !room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y).some(s =>
        s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_CONTAINER &&
        !(s.structureType === STRUCTURE_RAMPART && (/** @type {any} */ (s).my || /** @type {any} */ (s).isPublic))) &&
        !roomData.sites(room).some(s => s.pos.isEqualTo(pos) && s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_RAMPART);
}

/** @param {Room} room @param {RoomPosition} source */
function workingTiles(room, source) {
    /** @type {RoomPosition[]} */
    const tiles = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const p = new RoomPosition(source.x + dx, source.y + dy, room.name);
        if (walkable(room, p)) tiles.push(p);
    }
    return tiles;
}

/** @param {Creep} creep */
function preferred(creep) { return !!creep.memory.b && creep.memory.b.endsWith(':0'); }

/** @param {Creep} a @param {Creep} b */
function rank(a, b) {
    return Number(preferred(b)) - Number(preferred(a)) ||
        (b.ticksToLive || 0) - (a.ticksToLive || 0) || a.name.localeCompare(b.name);
}

/** @param {Creep} creep @param {string|null} target @param {string} reason @param {any} data */
function setTarget(creep, target, reason, data) {
    const bindings = cache.store('mining.bindings');
    const key = `${creep.memory.m}|${data.mode}|${data.containerId || '-'}|${target || '-'}|${reason}`;
    const pos = target && unpack(target);
    if (bindings[creep.name] !== key) {
        const task = creep.memory.t;
        // Rebuild heap ownership without interrupting a healthy miner's cycle.
        const compatible = bindings[creep.name] === undefined && pos && creep.pos.isEqualTo(pos) && task &&
            ((task.a === 'harvest' && task.i === data.sourceId) ||
                (task.a === 'transfer' && (data.dropoffIds || []).includes(task.i)) ||
                (task.a === 'drop' && reason === 'overflow'));
        if (!compatible) delete creep.memory.t;
        bindings[creep.name] = key;
    }
    const task = creep.memory.t;
    // Never let an old CONTINUE harvest task bypass a new working position.
    if (task && pos && !creep.pos.isEqualTo(pos) && !(task.a === 'move' && task.p === target && task.n === 0)) delete creep.memory.t;
    if (reason === 'waiting' && task && task.a !== 'move' && task.a !== 'wait') delete creep.memory.t;
}

/** @param {Room} room @param {Creep} creep @param {RoomPosition} anchor @param {Set<string>} excluded @param {Set<string>} used */
function staging(room, creep, anchor, excluded, used) {
    const current = pack(creep.pos);
    if (creep.pos.inRangeTo(anchor, 1) && !excluded.has(current) && !used.has(current) && walkable(room, creep.pos)) return creep.pos;
    /** @type {RoomPosition[]} */
    const choices = [];
    for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
        const p = new RoomPosition(anchor.x + dx, anchor.y + dy, room.name);
        const k = pack(p);
        if (excluded.has(k) || used.has(k) || !walkable(room, p)) continue;
        if (room.lookForAt(LOOK_CREEPS, p.x, p.y).some(c => c.name !== creep.name)) continue;
        choices.push(p);
    }
    choices.sort((a, b) => a.getRangeTo(anchor) - b.getRangeTo(anchor) || creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b) || a.x - b.x || a.y - b.y);
    return choices[0] || null;
}

/**
 * One stable assignment per living miner; rebuildable after a VM reset. A
 * ready replacement takes over only at a handoff, not merely because it spawned.
 * @param {import('../contracts/ctx').RoomCtx} rc
 */
function reconcile(rc) {
    const room = rc.room;
    const miners = rc.census ? rc.census.active.filter(c => c.memory.a === 'miner' && c.room.name === room.name) : [];
    const states = cache.store('mining.stations');
    const targets = cache.store('mining.targets');
    const reservations = cache.store('mining.reservations');
    /** @type {Record<string, string>} */
    const reserved = {};
    const used = new Set();
    const missions = (rc.missions || []).filter(m => m.type === 'harvest');
    const excluded = new Set();
    for (const m of missions) {
        const src = Game.getObjectById(/** @type {Id<Source>} */ (m.targetId));
        if (src) for (const p of workingTiles(room, src.pos)) excluded.add(pack(p));
    }
    // Link loading stations and source-container approaches belong to hauling.
    for (const m of rc.missions || []) {
        const d = /** @type {any} */ (m.data);
        if (m.type === 'miningLane' && d && Number.isFinite(d.station)) excluded.add(pack(new RoomPosition(d.station % 50, Math.floor(d.station / 50), room.name)));
    }
    for (const mission of missions) {
        const data = /** @type {any} */ (mission.data);
        const assigned = miners.filter(c => c.memory.m === mission.id);
        const source = Game.getObjectById(/** @type {Id<Source>} */ (data.sourceId));
        const container = data.containerId && Game.getObjectById(/** @type {Id<StructureContainer>} */ (data.containerId));
        const prior = states[mission.id];
        if (data.mode !== 'static' || !container || !source) {
            for (const c of assigned) {
                delete targets[c.name];
                setTarget(c, null, data.mode, data);
            }
            delete states[mission.id];
            continue;
        }
        const tiles = workingTiles(room, source.pos);
        const occupant = assigned.find(c => c.pos.isEqualTo(container.pos));
        let owner = prior && assigned.find(c => c.name === prior.owner);
        if (!owner) owner = occupant || assigned.slice().sort(rank)[0];
        // An incumbent remains productive while the replacement travels. Once
        // staged, prefer slot 0 over a retained overflow, or replace an expiring owner.
        const sustainableWork = Math.ceil(source.energyCapacity / ENERGY_REGEN_TIME / HARVEST_POWER);
        const needsHandoff = c => !owner || (owner.ticksToLive || 0) <= HANDOFF_TTL ||
            (!preferred(owner) && preferred(c)) ||
            (owner.getActiveBodyparts(WORK) < sustainableWork && c.getActiveBodyparts(WORK) > owner.getActiveBodyparts(WORK));
        const ready = assigned.filter(c => c !== owner && c.pos.inRangeTo(container.pos, 1) &&
            (c.ticksToLive || 0) > HANDOFF_TTL && needsHandoff(c)).sort(rank);
        if (ready.length) owner = ready[0];
        if (!owner) continue;
        const assignments = {};
        const primary = pack(container.pos);
        assignments[owner.name] = { target: primary, reason: 'container' };
        used.add(primary);
        reserved[primary] = owner.name;
        const others = assigned.filter(c => c !== owner).sort(rank);
        for (const c of others) {
            const previous = targets[c.name] && unpack(targets[c.name].target);
            const open = tiles.filter(p => !p.isEqualTo(container.pos) && !used.has(pack(p)) &&
                !room.lookForAt(LOOK_CREEPS, p.x, p.y).some(o => o.name !== c.name && !assigned.includes(o)));
            // Same-slot replacements wait off the source until handoff; other
            // retained miners may contribute from a real overflow position.
            const sameBinding = c.memory.b && c.memory.b === owner.memory.b;
            open.sort((a, b) => Number(c.pos.isEqualTo(b)) - Number(c.pos.isEqualTo(a)) ||
                Number(!!previous && b.isEqualTo(previous)) - Number(!!previous && a.isEqualTo(previous)) ||
                c.pos.getRangeTo(a) - c.pos.getRangeTo(b) || a.x - b.x || a.y - b.y);
            const p = !sameBinding && open[0] || staging(room, c, container.pos, excluded, used);
            const target = p ? pack(p) : null;
            const reason = !sameBinding && open[0] ? 'overflow' : 'waiting';
            assignments[c.name] = { target, reason };
            if (target) { used.add(target); reserved[target] = c.name; }
        }
        states[mission.id] = { owner: owner.name, room: room.name, container: container.id, t: Game.time };
        for (const c of assigned) {
            targets[c.name] = Object.assign({ mission: mission.id, t: Game.time }, assignments[c.name]);
            setTarget(c, assignments[c.name].target, assignments[c.name].reason, data);
        }
    }
    reservations[room.name] = { t: Game.time, positions: reserved };
    for (const key in states) if (states[key].room === room.name && !missions.some(m => m.id === key)) delete states[key];
    for (const name in targets) if (!Game.creeps[name]) { delete targets[name]; delete cache.store('mining.bindings')[name]; }
}

/** @param {Creep} creep */
function assignment(creep) { return cache.store('mining.targets')[creep.name]; }

/** @param {string} roomName */
function reserved(roomName) {
    const entry = cache.store('mining.reservations')[roomName];
    return entry && entry.t === Game.time ? entry.positions : {};
}

module.exports = { reconcile, assignment, reserved, workingTiles, HANDOFF_TTL };
