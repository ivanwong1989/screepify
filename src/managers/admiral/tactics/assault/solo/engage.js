const { getHostilesInRoom, filterOutAllies } = require('managers_admiral_tactics_assault_common_threat');

function selectTarget(creep, flags, ao) {
    if (!creep || !creep.room) return null;
    const hostiles = getHostilesInRoom(creep.room);
    if (hostiles && hostiles.length > 0) {
        return creep.pos.findClosestByRange(hostiles);
    }

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
    hostileStructures = hostileStructures.filter(s => s.structureType !== STRUCTURE_CONTROLLER);
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
