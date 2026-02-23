// managers_admiral_tactics_assault_duo_engage.js

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

function selectTarget(creep, flags, ao) {
    if (!creep || !creep.room) return null;

    const hostiles = creep.room.find(FIND_HOSTILE_CREEPS)
        .filter(h => inAO(h.pos, ao));
    if (hostiles.length > 0) {
        return creep.pos.findClosestByRange(hostiles);
    }

    const hostileStructures = creep.room.find(FIND_HOSTILE_STRUCTURES, {
        filter: s =>
            s.structureType !== STRUCTURE_CONTROLLER &&
            inAO(s.pos, ao)
    });
    if (hostileStructures.length > 0) {
        return creep.pos.findClosestByRange(hostileStructures);
    }

    // Attack flag tile preference (only if inside AO too)
    if (flags.attackPos && flags.attackPos.roomName === creep.room.name && inAO(flags.attackPos, ao)) {
        const structuresAt = creep.room.lookForAt(LOOK_STRUCTURES, flags.attackPos.x, flags.attackPos.y);
        if (structuresAt && structuresAt.length > 0) return structuresAt[0];
    }

    // Near AO center fallback (bounded by radius anyway)
    if (ao.centerPos && ao.centerPos.roomName === creep.room.name) {
        const center = new RoomPosition(ao.centerPos.x, ao.centerPos.y, ao.centerPos.roomName);
        const nearby = center.findInRange(FIND_HOSTILE_STRUCTURES, 3, {
            filter: s => s.structureType !== STRUCTURE_CONTROLLER
        }).filter(s => inAO(s.pos, ao));
        if (nearby.length > 0) return nearby[0];
    }

    return null;
}

module.exports = { selectTarget };