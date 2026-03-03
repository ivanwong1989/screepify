// managers_admiral_tactics_assault_duo_engage.js

const { getHostilesInRoom, filterOutAllies } = require('managers_admiral_tactics_assault_common_threat');

function toRoomPos(p) {
    if (!p) return null;
    if (p instanceof RoomPosition) return p;
    return new RoomPosition(p.x, p.y, p.roomName || (p.room && p.room.name));
}

function inAO(pos, ao) {
    if (!ao || !ao.centerPos) return true;
    const radius = Number(ao.radius) || 0;
    if (radius <= 0) return true; // radius=0 means "no AO constraint"
    const c = toRoomPos(ao.centerPos);
    if (!c) return true;
    if (!pos || pos.roomName !== c.roomName) return false;
    return c.getRangeTo(pos) <= radius;
}

function isSourceKeeperOwned(o) {
    const owner = o && o.owner;
    const u = owner && owner.username;
    return (typeof u === 'string') && (u.toLowerCase() === 'source keeper');
}

function selectTarget(creep, flags, ao) {
    if (!creep || !creep.room) return null;

    // HARD AO ROOM GATE
    if (ao && ao.centerPos && creep.room.name !== ao.centerPos.roomName) {
        return null;
    }
    
    // Hostile creeps in AO, but DO NOT engage Source Keepers as targets.
    // (They still exist in threat evaluation via getHostilesInRoom elsewhere.)
    const hostiles = getHostilesInRoom(creep.room)
        .filter(h => inAO(h.pos, ao));

    const engageable = hostiles.filter(h => !isSourceKeeperOwned(h));

    if (engageable.length > 0) {
        return creep.pos.findClosestByRange(engageable);
    }

    // Optional: if ONLY SKs exist, we intentionally return null here so ENGAGE
    // doesn't chase them. Other phase logic can decide to hold/retreat/etc.

    // Prefer cache-hostileStructures if present (already filters allies)
    let hostileStructures = null;
    try {
        if (global.getRoomCache) {
            const cache = global.getRoomCache(creep.room);
            if (cache && Array.isArray(cache.hostileStructures)) hostileStructures = cache.hostileStructures;
        }
    } catch (e) {
        // ignore
    }

    hostileStructures = hostileStructures.filter(s =>
        s.structureType !== STRUCTURE_CONTROLLER &&
        s.structureType !== STRUCTURE_WALL &&
        s.structureType !== STRUCTURE_RAMPART &&
        inAO(s.pos, ao)
    );

    if (hostileStructures.length > 0) {
        return creep.pos.findClosestByRange(hostileStructures);
    }

    // --- Fallback: attack weakest wall/rampart inside AO ---
    // Walls are NOT "hostile structures", so we must scan FIND_STRUCTURES.
    let walls = creep.room.find(FIND_STRUCTURES, {
        filter: s =>
            (s.structureType === STRUCTURE_WALL) &&
            inAO(s.pos, ao)
    });

    if (walls && walls.length > 0) {
        walls.sort((a, b) => a.hits - b.hits);
        return walls[0];
    }

    // Attack flag tile preference (only if inside AO too)
    if (flags.attackPos && flags.attackPos.roomName === creep.room.name && inAO(flags.attackPos, ao)) {
        const structuresAt = creep.room.lookForAt(LOOK_STRUCTURES, flags.attackPos.x, flags.attackPos.y);

        const filtered = (structuresAt || []).filter(s =>
            s.structureType !== STRUCTURE_CONTROLLER &&
            !filterOutAllies([s]).length === false // ally-safe check
        );

        if (filtered.length > 0) return filtered[0];
    }

    // Near AO center fallback (bounded by radius anyway)
    if (ao.centerPos && ao.centerPos.roomName === creep.room.name) {
        const center = new RoomPosition(ao.centerPos.x, ao.centerPos.y, ao.centerPos.roomName);
        const nearby = center.findInRange(FIND_HOSTILE_STRUCTURES, 3, {
            filter: s => s.structureType !== STRUCTURE_CONTROLLER &&
            !isAllyOwner(s.owner)
        }).filter(s => inAO(s.pos, ao));
        if (nearby.length > 0) return nearby[0];
    }

    return null;
}

module.exports = { selectTarget };