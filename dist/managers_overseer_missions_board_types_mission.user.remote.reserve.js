const userMissions = require('userMissions');
const heap = require('utils_heap');

const RESERVER_SEGMENT_COST = 650; // CLAIM + MOVE
const RESERVER_EFFECTIVE_LIFETIME = 650;
const RESERVE_TRAVEL_CACHE_TTL = 10000;
const RESERVE_SPAWN_QUEUE_BUFFER = 15;
const RESERVE_SAFETY_BUFFER = 25;

function getMyUsername(room) {
    if (room && room.controller && room.controller.my && room.controller.owner) {
        return room.controller.owner.username;
    }
    const spawns = room ? room.find(FIND_MY_SPAWNS) : [];
    if (spawns && spawns.length > 0 && spawns[0].owner) return spawns[0].owner.username;
    return null;
}

function getReserveTimerStore(room) {
    if (!room.memory.overseer) room.memory.overseer = {};
    if (!room.memory.overseer.reserve) room.memory.overseer.reserve = {};
    if (!room.memory.overseer.reserve.timers) room.memory.overseer.reserve.timers = {};
    return room.memory.overseer.reserve.timers;
}

function getReserverSegments(room) {
    return Math.max(1, Math.min(2, Math.floor(room.energyCapacityAvailable / RESERVER_SEGMENT_COST)));
}

function estimateTravelTicks(pathLen, bodyLen, moveParts) {
    if (!pathLen || pathLen <= 0) return 0;
    if (!bodyLen || bodyLen <= 0) return pathLen;
    if (!moveParts || moveParts <= 0) return pathLen * bodyLen;
    const ticksPerStep = Math.max(1, Math.ceil(bodyLen / (2 * moveParts)));
    return pathLen * ticksPerStep;
}

function getReserveTravelEstimate(room, targetPos) {
    if (!room || !targetPos || !targetPos.roomName) {
        return { distance: 0, travelTicks: 0, fromSpawnId: null };
    }

    const store = heap.getStore('reserveTravel', { ttl: RESERVE_TRAVEL_CACHE_TTL });
    const cacheKey = `${room.name}:${targetPos.roomName}:${targetPos.x},${targetPos.y}`;
    const cached = store[cacheKey];
    if (cached) {
        const segments = getReserverSegments(room);
        const bodyLen = segments * 2;
        const moveParts = segments;
        const travelTicks = estimateTravelTicks(cached.distance || 0, bodyLen, moveParts);
        return { distance: cached.distance || 0, travelTicks, fromSpawnId: cached.fromSpawnId || null };
    }

    const roomCache = global.getRoomCache(room);
    const spawns = (roomCache && roomCache.myStructuresByType && roomCache.myStructuresByType[STRUCTURE_SPAWN]) || [];

    let bestDistance = Infinity;
    let bestSpawnId = null;
    const target = new RoomPosition(targetPos.x, targetPos.y, targetPos.roomName);
    for (let i = 0; i < spawns.length; i++) {
        const spawn = spawns[i];
        if (!spawn || !spawn.pos) continue;
        const path = spawn.pos.findPathTo(target, {
            range: 1,
            ignoreCreeps: true,
            maxOps: 2000
        });
        const pathLen = path ? path.length : 0;
        if (pathLen > 0 && pathLen < bestDistance) {
            bestDistance = pathLen;
            bestSpawnId = spawn.id;
        }
    }

    const distance = Number.isFinite(bestDistance) && bestDistance !== Infinity ? bestDistance : 0;
    if (distance > 0) {
        store[cacheKey] = { distance, fromSpawnId: bestSpawnId };
    }

    const segments = getReserverSegments(room);
    const bodyLen = segments * 2;
    const moveParts = segments;
    const travelTicks = estimateTravelTicks(distance, bodyLen, moveParts);
    return { distance, travelTicks, fromSpawnId: bestSpawnId };
}

function getReserveSpawnThresholdTicks(room, travelTicks) {
    const segments = getReserverSegments(room);
    const bodyLen = segments * 2;
    const spawnTime = bodyLen * CREEP_SPAWN_TIME;
    const effectiveTravel = Math.max(0, Math.floor(travelTicks || 0));
    const sustainInterval = segments * Math.max(0, RESERVER_EFFECTIVE_LIFETIME - effectiveTravel);
    const spawnLead = spawnTime + effectiveTravel + RESERVE_SPAWN_QUEUE_BUFFER + RESERVE_SAFETY_BUFFER;
    return Math.max(spawnLead, sustainInterval);
}

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
            pos: mission.targetPos,
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
        const timerStore = getReserveTimerStore(room);
        const myUser = getMyUsername(room);
        const activeIds = new Set(missionEntries.map(entry => entry.id));

        for (const id of Object.keys(timerStore)) {
            if (!activeIds.has(id)) delete timerStore[id];
        }

        for (const entry of missionEntries) {
            const missionId = entry.id;
            const nameSuffix = entry.label ? `${missionId}:${entry.label}` : missionId;
            const missionName = `reserve:${nameSuffix}`;
            const census = getMissionCensus(missionName);
            const targetRoom = entry.targetRoom;
            let targetPos = entry.pos;
            const visible = Game.rooms[targetRoom];
            if (visible && visible.controller) {
                const cPos = visible.controller.pos;
                if (!targetPos || targetPos.x !== cPos.x || targetPos.y !== cPos.y) {
                    targetPos = { x: cPos.x, y: cPos.y, roomName: targetRoom };
                    userMissions.updateMission(missionId, { targetPos });
                }
            }
            if (!targetPos) targetPos = { x: 25, y: 25, roomName: targetRoom };
            const timer = timerStore[missionId] || {};
            let reservationTicks = null;
            const travel = getReserveTravelEstimate(room, targetPos);
            const claimThreshold = getReserveSpawnThresholdTicks(room, travel.travelTicks);

            if (myUser) {
                const visible = Game.rooms[targetRoom];
                if (visible && visible.controller) {
                    const reservation = visible.controller.reservation;
                    if (reservation && reservation.username === myUser) {
                        reservationTicks = reservation.ticksToEnd;
                        timer.reservationEndsAt = Game.time + reservationTicks;
                    } else {
                        delete timer.reservationEndsAt;
                    }
                } else if (Number.isFinite(timer.reservationEndsAt)) {
                    reservationTicks = timer.reservationEndsAt - Game.time;
                    if (reservationTicks <= 0) {
                        delete timer.reservationEndsAt;
                        reservationTicks = 0;
                    }
                }
            } else {
                delete timer.reservationEndsAt;
            }

            timerStore[missionId] = timer;
            const spawnAllowed = canSpawn && (reservationTicks === null || reservationTicks <= claimThreshold);

            missions.push({
                name: missionName,
                type: 'remote_reserve',
                archetype: 'reserver',
                requirements: {
                    archetype: 'reserver',
                    minCount: 1,
                    maxCount: 1,
                    spawn: spawnAllowed
                },
                targetPos: targetPos,
                data: {
                    userMissionId: missionId,
                    targetRoom: targetRoom,
                    targetPos: targetPos,
                    persist: entry.persist === true,
                    sourceDistance: travel.distance,
                    travelTicks: travel.travelTicks,
                    preSpawnLeadTicks: claimThreshold,
                    travelFromSpawnId: travel.fromSpawnId
                },
                priority: entry.priority,
                census: census
            });
        }
    }
};
