const userMissions = require('userMissions');

const MIN_DRAINER_BUDGET = 310; // TOUGH + MOVE + HEAL
const BASE_PATTERN = [TOUGH, MOVE, HEAL];
const HEAVY_PATTERN = [TOUGH, TOUGH, MOVE, HEAL, MOVE];

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
    const roomName = mission.targetRoom || (mission.targetPos && mission.targetPos.roomName) || mission.roomName;
    return userMissions.normalizeRoomName(roomName);
}

function normalizeTargetPos(pos, fallbackRoom) {
    if (!pos) return null;
    if (pos instanceof RoomPosition) {
        return { x: pos.x, y: pos.y, roomName: pos.roomName };
    }
    const roomName = pos.roomName || fallbackRoom;
    const x = Number(pos.x);
    const y = Number(pos.y);
    if (!roomName || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, roomName };
}

function getBodyPattern(budget) {
    if (budget >= 370) return HEAVY_PATTERN;
    return BASE_PATTERN;
}

function buildDrainerMissionCache() {
    const cache = global._drainerMissionCache;
    if (cache && cache.time === Game.time) return cache;

    const missions = userMissions.getByType('drainer');
    if (!missions || missions.length === 0) {
        const empty = { time: Game.time, bySponsorRoom: {} };
        global._drainerMissionCache = empty;
        return empty;
    }

    const ownedRooms = getOwnedSpawnRoomsCached();
    if (ownedRooms.length === 0) {
        const empty = { time: Game.time, bySponsorRoom: {} };
        global._drainerMissionCache = empty;
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
        if (visible) {
            const hostileTowers = visible.find(FIND_HOSTILE_STRUCTURES, {
                filter: s => s.structureType === STRUCTURE_TOWER
            });
            if (hostileTowers.length === 0 && mission.persist !== true) {
                userMissions.removeMission(mission.id);
                continue;
            }
        }

        const targetPos = normalizeTargetPos(mission.targetPos, targetRoom);

        if (!bySponsorRoom[sponsorRoom]) bySponsorRoom[sponsorRoom] = [];
        bySponsorRoom[sponsorRoom].push({
            id: mission.id,
            label: mission.label,
            targetRoom,
            targetPos,
            priority: getMissionPriority(mission),
            persist: mission.persist === true
        });
    }

    const result = { time: Game.time, bySponsorRoom };
    global._drainerMissionCache = result;
    return result;
}

module.exports = {
    generate: function(room, intel, context, missions) {
        const cache = buildDrainerMissionCache();
        const entries = cache.bySponsorRoom[room.name];
        if (!entries || entries.length === 0) return;

        const { budget, getMissionCensus } = context;
        const spawnAllowed = budget >= MIN_DRAINER_BUDGET;
        const bodyPattern = getBodyPattern(budget);

        for (const entry of entries) {
            const missionId = entry.id;
            const nameSuffix = entry.label ? `${missionId}:${entry.label}` : missionId;
            const missionName = `drain:${nameSuffix}`;
            const census = typeof getMissionCensus === 'function' ? getMissionCensus(missionName) : { count: 0, workParts: 0, carryParts: 0 };
            const targetPos = entry.targetPos || { x: 25, y: 25, roomName: entry.targetRoom };

            debug('mission.drainer', `[Drainer] ${room.name} -> ${entry.targetRoom} target=${targetPos.x},${targetPos.y} spawn=${spawnAllowed}`);

            missions.push({
                name: missionName,
                type: 'drain',
                archetype: 'drainer',
                requirements: {
                    archetype: 'drainer',
                    count: 1,
                    body: bodyPattern,
                    spawn: spawnAllowed
                },
                targetPos: targetPos,
                pos: targetPos,
                data: {
                    userMissionId: missionId,
                    targetRoom: entry.targetRoom,
                    targetPos: targetPos,
                    sponsorRoom: room.name,
                    persist: entry.persist === true
                },
                priority: entry.priority,
                census: census
            });
        }
    }
};
