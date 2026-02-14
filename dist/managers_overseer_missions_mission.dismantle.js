const userMissions = require('userMissions');

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

function getMissionPriority(mission) {
    if (mission && Number.isFinite(mission.priority)) return mission.priority;
    return 60;
}

function isValidTargetPos(pos) {
    if (!pos || !pos.roomName) return false;
    const x = Number(pos.x);
    const y = Number(pos.y);
    return Number.isFinite(x) && Number.isFinite(y);
}

function buildDismantleMissionCache() {
    const cache = global._dismantleMissionCache;
    if (cache && cache.time === Game.time) return cache;

    const missions = userMissions.getByType('dismantle');
    if (!missions || missions.length === 0) {
        const empty = { time: Game.time, bySponsorRoom: {} };
        global._dismantleMissionCache = empty;
        return empty;
    }

    const ownedRooms = getOwnedSpawnRoomsCached();
    if (ownedRooms.length === 0) {
        const empty = { time: Game.time, bySponsorRoom: {} };
        global._dismantleMissionCache = empty;
        return empty;
    }
    const ownedSet = new Set(ownedRooms);

    const bySponsorRoom = {};
    for (const mission of missions) {
        if (mission.enabled === false) continue;
        const targetPos = mission.targetPos;
        if (!isValidTargetPos(targetPos)) continue;

        const sponsorRoom = mission.sponsorRoom;
        if (!sponsorRoom || !ownedSet.has(sponsorRoom)) continue;

        let targetId = mission.targetId || null;
        if (targetId) {
            const target = Game.getObjectById(targetId);
            if (!target) {
                const visible = Game.rooms[targetPos.roomName];
                if (visible && mission.persist !== true) {
                    userMissions.removeMission(mission.id);
                    continue;
                }
                targetId = null;
            }
        }

        if (!bySponsorRoom[sponsorRoom]) bySponsorRoom[sponsorRoom] = [];
        bySponsorRoom[sponsorRoom].push({
            id: mission.id,
            label: mission.label,
            pos: targetPos,
            priority: getMissionPriority(mission),
            targetId: targetId,
            persist: mission.persist === true
        });
    }

    const result = { time: Game.time, bySponsorRoom };
    global._dismantleMissionCache = result;
    return result;
}

module.exports = {
    generate: function(room, intel, context, missions) {
        const cache = buildDismantleMissionCache();
        const missionEntries = cache.bySponsorRoom[room.name];
        if (!missionEntries || missionEntries.length === 0) return;

        for (const entry of missionEntries) {
            const missionId = entry.id;
            const nameSuffix = entry.label ? `${missionId}:${entry.label}` : missionId;
            missions.push({
                name: `dismantle:${nameSuffix}`,
                type: 'dismantle',
                archetype: 'dismantler',
                requirements: {
                    archetype: 'dismantler',
                    count: 2
                },
                targetId: entry.targetId || null,
                data: {
                    userMissionId: missionId,
                    targetPos: { x: entry.pos.x, y: entry.pos.y, roomName: entry.pos.roomName },
                    persist: entry.persist === true
                },
                priority: entry.priority
            });
        }
    }
};
