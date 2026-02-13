const userMissions = require('userMissions');

const RESERVER_SEGMENT_COST = 650; // CLAIM + MOVE

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

function resolveTargetRoom(mission) {
    if (!mission) return '';
    const roomName = mission.targetRoom || (mission.targetPos && mission.targetPos.roomName);
    return userMissions.normalizeRoomName(roomName);
}

function buildReserveMissionCache() {
    const cache = global._reserveMissionCache;
    if (cache && cache.time === Game.time) return cache;

    const missions = userMissions.getByType('reserve');
    if (!missions || missions.length === 0) {
        const empty = { time: Game.time, bySponsorRoom: {} };
        global._reserveMissionCache = empty;
        return empty;
    }

    const ownedRooms = getOwnedSpawnRoomsCached();
    if (ownedRooms.length === 0) {
        const empty = { time: Game.time, bySponsorRoom: {} };
        global._reserveMissionCache = empty;
        return empty;
    }
    const ownedSet = new Set(ownedRooms);

    const bySponsorRoom = {};
    for (const mission of missions) {
        if (mission.enabled === false) continue;

        const targetRoom = resolveTargetRoom(mission);
        if (!targetRoom) continue;

        const sponsorRoom = mission.sponsorRoom;
        if (!sponsorRoom || !ownedSet.has(sponsorRoom)) continue;

        const visible = Game.rooms[targetRoom];
        if (visible && visible.controller) {
            if (visible.controller.owner && !visible.controller.my) {
                if (mission.persist !== true) {
                    userMissions.removeMission(mission.id);
                }
                continue;
            }
            if (visible.controller.my) {
                if (mission.persist !== true) {
                    userMissions.removeMission(mission.id);
                }
                continue;
            }
        }

        if (!bySponsorRoom[sponsorRoom]) bySponsorRoom[sponsorRoom] = [];
        bySponsorRoom[sponsorRoom].push({
            id: mission.id,
            label: mission.label,
            targetRoom,
            priority: getMissionPriority(mission),
            persist: mission.persist === true
        });
    }

    const result = { time: Game.time, bySponsorRoom };
    global._reserveMissionCache = result;
    return result;
}

module.exports = {
    generate: function(room, intel, context, missions) {
        const cache = buildReserveMissionCache();
        const missionEntries = cache.bySponsorRoom[room.name];
        if (!missionEntries || missionEntries.length === 0) return;

        const minCost = RESERVER_SEGMENT_COST;
        const canSpawn = room.energyCapacityAvailable >= minCost;
        const { getMissionCensus } = context;

        for (const entry of missionEntries) {
            const missionId = entry.id;
            const nameSuffix = entry.label ? `${missionId}:${entry.label}` : missionId;
            const missionName = `reserve:${nameSuffix}`;
            const census = getMissionCensus(missionName);
            const targetRoom = entry.targetRoom;
            const targetPos = { x: 25, y: 25, roomName: targetRoom };

            missions.push({
                name: missionName,
                type: 'remote_reserve',
                archetype: 'reserver',
                requirements: {
                    archetype: 'reserver',
                    count: 1,
                    spawn: canSpawn
                },
                targetPos: targetPos,
                data: {
                    userMissionId: missionId,
                    targetRoom: targetRoom,
                    targetPos: targetPos,
                    persist: entry.persist === true
                },
                priority: entry.priority,
                census: census
            });
        }
    }
};
