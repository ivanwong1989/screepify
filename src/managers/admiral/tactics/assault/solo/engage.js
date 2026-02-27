// managers_admiral_tactics_assault_solo_engage.js

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

function getEngageContext(creep, flags, ao, debugOut) {
    const debug = debugOut || {
        reason: 'none',
        counts: {
            hostiles: 0,
            hostileStructures: 0,
            attackFlag: 0,
            aoNearby: 0
        }
    };
    if (!debug.counts) {
        debug.counts = {
            hostiles: 0,
            hostileStructures: 0,
            attackFlag: 0,
            aoNearby: 0
        };
    }

    const ctx = {
        target: null,
        hostiles: [],
        hostileStructures: [],
        hasHostiles: false,
        hasHostileStructures: false,
        debug
    };

    if (!creep || !creep.room) {
        debug.reason = 'no-creep';
        return ctx;
    }

    // Hostile creeps (AO-bounded)
    const hostiles = getHostilesInRoom(creep.room).filter(h => inAO(h.pos, ao));
    ctx.hostiles = hostiles;
    ctx.hasHostiles = hostiles.length > 0;
    debug.counts.hostiles = hostiles.length;

    if (hostiles.length > 0) {
        debug.reason = 'hostile-creep';
        ctx.target = creep.pos.findClosestByRange(hostiles);
        return ctx;
    }

    // Hostile structures (AO-bounded)
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
    if (!hostileStructures) {
        hostileStructures = filterOutAllies(creep.room.find(FIND_HOSTILE_STRUCTURES));
    }

    hostileStructures = hostileStructures
        .filter(s => s.structureType !== STRUCTURE_CONTROLLER && inAO(s.pos, ao));

    ctx.hostileStructures = hostileStructures;
    ctx.hasHostileStructures = hostileStructures.length > 0;
    debug.counts.hostileStructures = hostileStructures.length;

    if (hostileStructures.length > 0) {
        debug.reason = 'hostile-structure';
        ctx.target = creep.pos.findClosestByRange(hostileStructures);
        return ctx;
    }

    // Attack flag tile preference (only if inside AO too)
    if (flags.attackPos && flags.attackPos.roomName === creep.room.name && inAO(flags.attackPos, ao)) {
        const structuresAt = creep.room.lookForAt(LOOK_STRUCTURES, flags.attackPos.x, flags.attackPos.y);
        debug.counts.attackFlag = structuresAt ? structuresAt.length : 0;
        if (structuresAt && structuresAt.length > 0) {
            debug.reason = 'attack-flag-structure';
            ctx.target = structuresAt[0];
            return ctx;
        }
    }

    // Near AO center fallback (bounded by radius anyway)
    if (ao.centerPos && ao.centerPos.roomName === creep.room.name) {
        const center = new RoomPosition(ao.centerPos.x, ao.centerPos.y, ao.centerPos.roomName);
        const nearby = center.findInRange(FIND_HOSTILE_STRUCTURES, 3, {
            filter: s => s.structureType !== STRUCTURE_CONTROLLER
        }).filter(s => inAO(s.pos, ao));
        debug.counts.aoNearby = nearby.length;
        if (nearby.length > 0) {
            debug.reason = 'ao-center-nearby';
            ctx.target = nearby[0];
            return ctx;
        }
    }

    return ctx;
}

function selectTarget(creep, flags, ao, debugOut) {
    // Backwards-compatible: callers expecting a single target keep working.
    return getEngageContext(creep, flags, ao, debugOut).target;
}

module.exports = { selectTarget, getEngageContext };
