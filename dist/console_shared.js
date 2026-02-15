var userMissions = require('userMissions');

function getOwnedSpawnRoomsForMissionCreate() {
    const cache = global._ownedSpawnRoomsCache;
    if (cache && cache.time === Game.time) return cache.rooms;

    const owned = [];
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room || !room.controller || !room.controller.my) continue;
        const roomCache = global.getRoomCache(room);
        const spawns = roomCache.myStructuresByType[STRUCTURE_SPAWN] || [];
        if (spawns.length > 0) owned.push(roomName);
    }

    global._ownedSpawnRoomsCache = { time: Game.time, rooms: owned };
    return owned;
}

function resolveSponsorRoomForTargetPos(targetPos) {
    if (!targetPos || !targetPos.roomName) return null;
    const ownedRooms = getOwnedSpawnRoomsForMissionCreate();
    if (!ownedRooms || ownedRooms.length === 0) return null;
    const ownedSet = new Set(ownedRooms);
    if (ownedSet.has(targetPos.roomName)) return targetPos.roomName;

    let bestRoom = ownedRooms[0];
    let bestDist = Game.map.getRoomLinearDistance(targetPos.roomName, bestRoom);
    for (let i = 1; i < ownedRooms.length; i++) {
        const roomName = ownedRooms[i];
        const dist = Game.map.getRoomLinearDistance(targetPos.roomName, roomName);
        if (dist < bestDist) {
            bestDist = dist;
            bestRoom = roomName;
        }
    }
    return bestRoom;
}

function resolveSponsorRoomForTargetRoom(targetRoom) {
    const roomName = userMissions.normalizeRoomName(targetRoom);
    if (!roomName) return null;
    const ownedRooms = getOwnedSpawnRoomsForMissionCreate();
    if (!ownedRooms || ownedRooms.length === 0) return null;
    const ownedSet = new Set(ownedRooms);
    if (ownedSet.has(roomName)) return roomName;

    let bestRoom = ownedRooms[0];
    let bestDist = Game.map.getRoomLinearDistance(roomName, bestRoom);
    for (let i = 1; i < ownedRooms.length; i++) {
        const candidate = ownedRooms[i];
        const dist = Game.map.getRoomLinearDistance(roomName, candidate);
        if (dist < bestDist) {
            bestDist = dist;
            bestRoom = candidate;
        }
    }
    return bestRoom;
}

function resolveRoomNameForObjectId(objectId) {
    const id = objectId ? ('' + objectId).trim() : '';
    if (!id) return null;
    const obj = Game.getObjectById(id);
    if (!obj || !obj.room || !obj.room.name) return null;
    return obj.room.name;
}

function resolveSponsorRoomForTransfer(sourceId, targetId) {
    const targetRoom = resolveRoomNameForObjectId(targetId);
    const sourceRoom = resolveRoomNameForObjectId(sourceId);
    const roomName = targetRoom || sourceRoom;
    if (!roomName) return null;
    return resolveSponsorRoomForTargetRoom(roomName);
}

function tryResolveTargetIdForPos(targetPos) {
    if (!targetPos || !targetPos.roomName) return null;
    const room = Game.rooms[targetPos.roomName];
    if (!room) return null;
    const pos = new RoomPosition(Number(targetPos.x), Number(targetPos.y), targetPos.roomName);
    const structures = pos.lookFor(LOOK_STRUCTURES);
    if (!structures || structures.length === 0) return null;
    return structures[0].id;
}

module.exports = {
    getOwnedSpawnRoomsForMissionCreate,
    resolveSponsorRoomForTargetPos,
    resolveSponsorRoomForTargetRoom,
    resolveRoomNameForObjectId,
    resolveSponsorRoomForTransfer,
    tryResolveTargetIdForPos
};
