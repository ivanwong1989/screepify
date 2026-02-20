function toRoomPosition(pos) {
    if (!pos) return null;
    if (pos instanceof RoomPosition) return pos;
    if (!pos.roomName) return null;
    const x = Number(pos.x);
    const y = Number(pos.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return new RoomPosition(x, y, pos.roomName);
}

function getCachedObject(room, id) {
    if (!id) return null;
    if (room && room._idCache && room._idCache.has(id)) return room._idCache.get(id);
    return Game.getObjectById(id);
}

function updateState(creep, resourceType, options = {}) {
    const type = resourceType || RESOURCE_ENERGY;
    const requireFull = !!options.requireFull;
    const allowPartialWork = !!options.allowPartialWork;
    const used = creep.store.getUsedCapacity(type);
    const free = creep.store.getFreeCapacity(type);

    if (creep.memory.taskState === 'working' && used === 0) {
        creep.memory.taskState = 'idle';
        creep.say('idle');
    }

    if (creep.memory.taskState === 'gathering' && free === 0) {
        creep.memory.taskState = 'idle';
        creep.say('idle');
    }

    if (creep.memory.taskState === 'idle' || creep.memory.taskState === 'init' || !creep.memory.taskState) {
        if (used > 0 && (!requireFull || free === 0 || allowPartialWork)) {
            creep.memory.taskState = 'working';
            creep.say('work');
        } else {
            creep.memory.taskState = 'gathering';
            creep.say('gather');
        }
    }
}

function hasFreeHarvestSpot(creep, source) {
    if (!creep || !source || !source.pos || !creep.room) return false;
    const terrain = creep.room.getTerrain();
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const x = source.pos.x + dx;
            const y = source.pos.y + dy;
            if (x < 0 || x > 49 || y < 0 || y > 49) continue;
            if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
            const creeps = creep.room.lookForAt(LOOK_CREEPS, x, y);
            if (creeps && creeps.length > 0 && !(creeps.length === 1 && creeps[0].id === creep.id)) continue;
            return true;
        }
    }
    return false;
}

function unassignMission(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.missionName;
    delete creep.memory.taskState;
}

module.exports = {
    toRoomPosition,
    getCachedObject,
    updateState,
    hasFreeHarvestSpot,
    unassignMission
};
