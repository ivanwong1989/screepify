function selectTarget(creep, flags, ao) {
    if (!creep || !creep.room) return null;
    const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
    if (hostiles && hostiles.length > 0) {
        return creep.pos.findClosestByRange(hostiles);
    }

    const hostileStructures = creep.room.find(FIND_HOSTILE_STRUCTURES, {
        filter: s => s.structureType !== STRUCTURE_CONTROLLER
    });
    if (hostileStructures && hostileStructures.length > 0) {
        return creep.pos.findClosestByRange(hostileStructures);
    }

    if (flags.attackPos && flags.attackPos.roomName === creep.room.name) {
        const structuresAt = creep.room.lookForAt(LOOK_STRUCTURES, flags.attackPos.x, flags.attackPos.y);
        if (structuresAt && structuresAt.length > 0) return structuresAt[0];
    }

    if (ao.centerPos && ao.centerPos.roomName === creep.room.name) {
        const center = new RoomPosition(ao.centerPos.x, ao.centerPos.y, ao.centerPos.roomName);
        const nearby = center.findInRange(FIND_HOSTILE_STRUCTURES, 3, {
            filter: s => s.structureType !== STRUCTURE_CONTROLLER
        });
        if (nearby && nearby.length > 0) return nearby[0];
    }

    return null;
}

module.exports = {
    selectTarget
};
