function getOwnedSpawnRoomsCached() {
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

function resolveSponsorRoom(flag, ownedRooms, ownedSet) {
    if (flag.memory && flag.memory.sponsorRoom) return flag.memory.sponsorRoom;
    if (ownedSet.has(flag.pos.roomName)) return flag.pos.roomName;
    if (!ownedRooms || ownedRooms.length === 0) return null;

    let bestRoom = ownedRooms[0];
    let bestDist = Game.map.getRoomLinearDistance(flag.pos.roomName, bestRoom);
    for (let i = 1; i < ownedRooms.length; i++) {
        const roomName = ownedRooms[i];
        const dist = Game.map.getRoomLinearDistance(flag.pos.roomName, roomName);
        if (dist < bestDist) {
            bestDist = dist;
            bestRoom = roomName;
        }
    }
    return bestRoom;
}

function getFlagPriority(flag) {
    if (flag.memory && Number.isFinite(flag.memory.priority)) return flag.memory.priority;
    return 60;
}

function tryResolveTargetId(flag) {
    const room = Game.rooms[flag.pos.roomName];
    if (!room) return null;
    const structures = flag.pos.lookFor(LOOK_STRUCTURES);
    if (!structures || structures.length === 0) return null;
    return structures[0].id;
}

function buildDismantleFlagCache() {
    const cache = global._dismantleFlagCache;
    if (cache && cache.time === Game.time) return cache;

    const flags = Object.values(Game.flags);
    if (!flags || flags.length === 0) {
        const empty = { time: Game.time, bySponsorRoom: {} };
        global._dismantleFlagCache = empty;
        return empty;
    }

    const matching = flags.filter(f =>
        f.color === COLOR_RED && f.secondaryColor === COLOR_PURPLE
    );

    if (matching.length === 0) {
        const empty = { time: Game.time, bySponsorRoom: {} };
        global._dismantleFlagCache = empty;
        return empty;
    }

    const ownedRooms = getOwnedSpawnRoomsCached();
    if (ownedRooms.length === 0) {
        const empty = { time: Game.time, bySponsorRoom: {} };
        global._dismantleFlagCache = empty;
        return empty;
    }
    const ownedSet = new Set(ownedRooms);

    const bySponsorRoom = {};
    for (const flag of matching) {
        const sponsorRoom = resolveSponsorRoom(flag, ownedRooms, ownedSet);
        if (!sponsorRoom) continue;

        let targetId = tryResolveTargetId(flag);
        if (!targetId) {
            const visible = Game.rooms[flag.pos.roomName];
            if (visible && (!flag.memory || flag.memory.persist !== true)) {
                const structures = flag.pos.lookFor(LOOK_STRUCTURES);
                if (!structures || structures.length === 0) {
                    flag.remove();
                    continue;
                }
            }
        }

        if (!bySponsorRoom[sponsorRoom]) bySponsorRoom[sponsorRoom] = [];
        bySponsorRoom[sponsorRoom].push({
            name: flag.name,
            pos: flag.pos,
            priority: getFlagPriority(flag),
            targetId: targetId
        });
    }

    const result = { time: Game.time, bySponsorRoom };
    global._dismantleFlagCache = result;
    return result;
}

module.exports = {
    generate: function(room, intel, context, missions) {
        const cache = buildDismantleFlagCache();
        const flags = cache.bySponsorRoom[room.name];
        if (!flags || flags.length === 0) return;

        for (const flag of flags) {
            missions.push({
                name: `dismantle:${flag.name}`,
                type: 'dismantle',
                archetype: 'dismantler',
                requirements: {
                    archetype: 'dismantler',
                    count: 1
                },
                targetId: flag.targetId || null,
                data: {
                    flagName: flag.name,
                    targetPos: { x: flag.pos.x, y: flag.pos.y, roomName: flag.pos.roomName }
                },
                priority: flag.priority
            });
        }
    }
};
