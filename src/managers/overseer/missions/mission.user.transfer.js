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

function normalizeId(value) {
    if (value === undefined || value === null) return '';
    return ('' + value).trim();
}

function normalizeResourceType(value) {
    if (value === undefined || value === null || value === '') return RESOURCE_ENERGY;
    return ('' + value).trim();
}

function getSourceAmount(source, resourceType) {
    if (!source) return 0;
    if (source instanceof Resource) {
        return source.resourceType === resourceType ? source.amount : 0;
    }
    if (source.store) return source.store[resourceType] || 0;
    return 0;
}

function getTargetFree(target, resourceType) {
    if (!target) return 0;
    if (target.store && typeof target.store.getFreeCapacity === 'function') {
        return target.store.getFreeCapacity(resourceType) || 0;
    }
    return 0;
}

function buildTransferMissionCache() {
    const cache = global._transferMissionCache;
    if (cache && cache.time === Game.time) return cache;

    const missions = userMissions.getByType('transfer');
    if (!missions || missions.length === 0) {
        const empty = { time: Game.time, bySponsorRoom: {} };
        global._transferMissionCache = empty;
        return empty;
    }

    const ownedRooms = getOwnedSpawnRoomsCached();
    if (ownedRooms.length === 0) {
        const empty = { time: Game.time, bySponsorRoom: {} };
        global._transferMissionCache = empty;
        return empty;
    }
    const ownedSet = new Set(ownedRooms);

    const bySponsorRoom = {};
    for (const mission of missions) {
        if (mission.enabled === false) continue;
        const sponsorRoom = normalizeId(mission.sponsorRoom);
        if (!sponsorRoom || !ownedSet.has(sponsorRoom)) continue;

        const sourceId = normalizeId(mission.sourceId);
        const targetId = normalizeId(mission.targetId);
        if (!sourceId || !targetId) continue;

        const targetRoom = normalizeId(mission.targetRoom);
        const sourceRoom = normalizeId(mission.sourceRoom);
        const remoteRoom = (targetRoom && targetRoom !== sponsorRoom)
            ? targetRoom
            : ((sourceRoom && sourceRoom !== sponsorRoom) ? sourceRoom : '');

        const resourceType = normalizeResourceType(mission.resourceType);
        const source = Game.getObjectById(sourceId);
        const target = Game.getObjectById(targetId);

        if ((!source || !target) && mission.persist !== true) {
            // If the objects should be visible (owned room), auto-complete the mission.
            if (Game.rooms[sponsorRoom]) {
                userMissions.removeMission(mission.id);
                continue;
            }
        }
        if (!source || !target) continue;

        const sourceAmount = getSourceAmount(source, resourceType);
        const targetFree = getTargetFree(target, resourceType);
        if ((sourceAmount <= 0 || targetFree <= 0) && mission.persist !== true) {
            userMissions.removeMission(mission.id);
            continue;
        }
        if (sourceAmount <= 0 || targetFree <= 0) continue;

        if (!bySponsorRoom[sponsorRoom]) bySponsorRoom[sponsorRoom] = [];
        bySponsorRoom[sponsorRoom].push({
            id: mission.id,
            label: mission.label,
            sourceId,
            targetId,
            resourceType,
            priority: getMissionPriority(mission),
            persist: mission.persist === true,
            remoteRoom,
            count: Number(mission.count) || 1
        });
    }

    const result = { time: Game.time, bySponsorRoom };
    global._transferMissionCache = result;
    return result;
}

module.exports = {
    generate: function(room, intel, context, missions) {
        const cache = buildTransferMissionCache();
        const missionEntries = cache.bySponsorRoom[room.name];
        if (!missionEntries || missionEntries.length === 0) return;

        for (const entry of missionEntries) {
            const missionId = entry.id;
            const nameSuffix = entry.label ? `${missionId}:${entry.label}` : missionId;
            missions.push({
                name: `userhaul:${nameSuffix}`,
                type: 'transfer',
                archetype: 'hauler',
                requirements: {
                    archetype: 'hauler',
                    count: entry.count,
                    spawn: false
                },
                targetId: entry.targetId,
                data: {
                    userMissionId: missionId,
                    sourceId: entry.sourceId,
                    resourceType: entry.resourceType,
                    persist: entry.persist === true,
                    targetRoom: entry.remoteRoom || null
                },
                priority: entry.priority
            });
        }
    }
};
