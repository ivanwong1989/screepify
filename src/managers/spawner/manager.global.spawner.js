function normalizeRoleName(role) {
    const raw = role ? String(role) : '';
    const lower = raw.toLowerCase();
    if (!lower) return '';

    if (lower === 'simpleharvest') return 'simple_miner';
    if (lower === 'mininglanehauler') return 'miningLaneHauler';
    if (lower === 'logisticscorehaulerv2') return 'coreLaneHauler';
    return raw;
}

function getRolePriorityRank(role) {
    const normalized = normalizeRoleName(role);
    switch (normalized) {
        case 'simple_miner':
            return 0; // simpleHarvest
        case 'simpleHaulerCore':
            return 1;
        case 'simpleMiningHauler':
            return 2;
        case 'miner':
            return 3;
        case 'coreLaneHauler':
            return 4;
        case 'miningLaneHauler':
            return 5;
        case 'upgrader':
            return 6;
        case 'worker':
            return 7;
        default:
            return 99;
    }
}

function getCandidateSpawnTier(candidate) {
    const role = normalizeRoleName(candidate && candidate.role ? candidate.role : '');
    const targetRoom = candidate && candidate.targetRoom ? candidate.targetRoom : null;
    const homeRoom = candidate && candidate.homeRoom ? candidate.homeRoom : null;

    if (
        role === 'simple_miner' ||
        role === 'miner' ||
        role === 'hauler' ||
        role === 'coreLaneHauler' ||
        role === 'miningLaneHauler' ||
        role === 'simpleHaulerCore' ||
        role === 'simpleMiningHauler'
    ) return 0;

    const remoteByRole = role.indexOf('remote_') === 0;
    const remoteByTarget = !!(targetRoom && homeRoom && targetRoom !== homeRoom);
    if (remoteByRole || remoteByTarget) return 2;

    return 1;
}

const ROOM_NAME_REGEX = /^([WE])(\d+)([NS])(\d+)$/;
const REMOTE_ASSIST_CACHE_RESET_TICKS = 1000;

function getRemoteAssistCache() {
    if (!global.__remoteAssistRoomPairCache || global.__remoteAssistRoomPairCacheTick + REMOTE_ASSIST_CACHE_RESET_TICKS < Game.time) {
        global.__remoteAssistRoomPairCache = Object.create(null);
        global.__remoteAssistRoomPairCacheTick = Game.time;
    }
    return global.__remoteAssistRoomPairCache;
}

function getRoomPairCacheKey(roomA, roomB) {
    if (!roomA || !roomB) return '';
    return roomA < roomB ? `${roomA}|${roomB}` : `${roomB}|${roomA}`;
}

function roomAxisToSigned(axis, value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return axis === 'W' || axis === 'N' ? -parsed - 1 : parsed;
}

function parseRoomName(roomName) {
    if (!roomName || typeof roomName !== 'string') return null;
    const match = ROOM_NAME_REGEX.exec(roomName);
    if (!match) return null;

    const x = roomAxisToSigned(match[1], match[2]);
    const y = roomAxisToSigned(match[3], match[4]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
}

function isCardinalAdjacentRoom(roomA, roomB) {
    const a = parseRoomName(roomA);
    const b = parseRoomName(roomB);
    if (!a || !b) return false;

    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    return (dx === 1 && dy === 0) || (dx === 0 && dy === 1);
}

function hasDirectExitBetweenRooms(roomA, roomB) {
    if (!roomA || !roomB || roomA === roomB) return false;
    const exitsA = Game.map.describeExits(roomA);
    if (!exitsA) return false;

    const roomBInA = Object.values(exitsA).some(name => name === roomB);
    if (!roomBInA) return false;

    const exitsB = Game.map.describeExits(roomB);
    if (!exitsB) return false;
    return Object.values(exitsB).some(name => name === roomA);
}

function isValidRemoteAssistRoom(homeRoomName, helperRoomName) {
    if (!homeRoomName || !helperRoomName) return false;
    const key = getRoomPairCacheKey(homeRoomName, helperRoomName);
    if (!key) return false;

    const cache = getRemoteAssistCache();
    if (cache[key] !== undefined) {
        return cache[key] === true;
    }

    const isValid = isCardinalAdjacentRoom(homeRoomName, helperRoomName) &&
        hasDirectExitBetweenRooms(homeRoomName, helperRoomName);
    cache[key] = isValid;
    return isValid;
}

function getHomeSpawnPosition(homeRoomName) {
    if (!homeRoomName) return null;
    const homeRoom = Game.rooms[homeRoomName];
    if (!homeRoom) return null;
    let spawns = null;
    if (global.getRoomCache) {
        const cache = global.getRoomCache(homeRoom);
        spawns = cache && cache.myStructuresByType && cache.myStructuresByType[STRUCTURE_SPAWN];
    }
    if (!spawns || spawns.length === 0) {
        spawns = homeRoom.find(FIND_MY_SPAWNS);
    }
    if (!spawns || spawns.length === 0) return null;
    const anchor = spawns[0];
    if (!anchor || !anchor.pos) return null;
    return { x: anchor.pos.x, y: anchor.pos.y, roomName: anchor.pos.roomName };
}

module.exports = {
    run: function(allCandidates) {
        if (!allCandidates || allCandidates.length === 0) return;

        const spawnDistanceCache = require('managers_spawner_spawnDistanceCache');
        spawnDistanceCache.syncSpawnRegistry();
        spawnDistanceCache.enqueueMissingPairs();
        spawnDistanceCache.processQueue({ maxPairsPerTick: 2 });

        allCandidates.sort((a, b) => {
            const roleRankA = getRolePriorityRank(a && a.role ? a.role : '');
            const roleRankB = getRolePriorityRank(b && b.role ? b.role : '');
            if (roleRankA !== roleRankB) return roleRankA - roleRankB;

            const tierA = getCandidateSpawnTier(a);
            const tierB = getCandidateSpawnTier(b);
            if (tierA !== tierB) return tierA - tierB;

            const prioA = Number.isFinite(a && a.priority) ? a.priority : 0;
            const prioB = Number.isFinite(b && b.priority) ? b.priority : 0;
            if (prioA !== prioB) return prioB - prioA;

            const deficitA = Number.isFinite(a && a.deficit) ? a.deficit : 0;
            const deficitB = Number.isFinite(b && b.deficit) ? b.deficit : 0;
            if (deficitA !== deficitB) return deficitB - deficitA;

            const idA = a && a.contractId ? String(a.contractId) : '';
            const idB = b && b.contractId ? String(b.contractId) : '';
            return idA.localeCompare(idB);
        });

        const availableSpawns = [];
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (!room.controller || !room.controller.my) continue;

            const spawns = room.find(FIND_MY_SPAWNS);
            for (const spawn of spawns) {
                if (!spawn.spawning) availableSpawns.push(spawn);
            }
        }

        for (const candidate of allCandidates) {
            if (availableSpawns.length === 0) break;

            const spawn = this.findBestSpawn(candidate, availableSpawns);
            if (!spawn) continue;

            debug('spawner', `[GlobalSpawner] assign contract=${candidate.contractId} role=${candidate.role} to spawn=${spawn.name} room=${spawn.room.name}`);
            this.executeSpawn(spawn, candidate);

            const index = availableSpawns.indexOf(spawn);
            if (index > -1) availableSpawns.splice(index, 1);
        }
    },

    findBestSpawn: function(candidate, availableSpawns) {
        const spawnDistanceCache = require('managers_spawner_spawnDistanceCache');
        const role = normalizeRoleName(candidate && candidate.role ? candidate.role : '');

        let candidates = availableSpawns.filter(s => s.room.energyCapacityAvailable >= candidate.cost);
        const localSpawns = candidates.filter(s => s.room.name === candidate.homeRoom);

        const readyLocal = localSpawns.find(s => s.room.energyAvailable >= candidate.cost);
        if (readyLocal) return readyLocal;

        const homeRoom = Game.rooms[candidate.homeRoom];
        const homeSpawns = homeRoom ? homeRoom.find(FIND_MY_SPAWNS) : [];
        const remoteCandidates = candidates.filter(s => {
            if (s.room.name === candidate.homeRoom) return false;
            if (role === 'miner' || role === 'simple_miner') return false;
            if (s.room.energyAvailable < candidate.cost) return false;
            if (s.room._policy && s.room._policy.state === 'CRITICAL') return false;
            return isValidRemoteAssistRoom(candidate.homeRoom, s.room.name);
        });

        if (remoteCandidates.length > 0) {
            remoteCandidates.sort((a, b) => {
                const distA = this.getBestSpawnDistance(candidate, a, homeSpawns, spawnDistanceCache);
                const distB = this.getBestSpawnDistance(candidate, b, homeSpawns, spawnDistanceCache);

                if (distA && distB) {
                    if (distA.rooms !== distB.rooms) return distA.rooms - distB.rooms;
                    if (distA.stepsApprox !== distB.stepsApprox) return distA.stepsApprox - distB.stepsApprox;
                } else if (distA && !distB) {
                    return -1;
                } else if (!distA && distB) {
                    return 1;
                }

                return b.room.energyAvailable - a.room.energyAvailable;
            });
            return remoteCandidates[0];
        }

        return null;
    },

    getBestSpawnDistance: function(candidate, candidateSpawn, homeSpawns, spawnDistanceCache) {
        if (!homeSpawns || homeSpawns.length === 0) return null;

        let best = null;
        for (const homeSpawn of homeSpawns) {
            const dist = spawnDistanceCache.getDistance(homeSpawn.id, candidateSpawn.id);
            if (dist === undefined || dist === null) continue;
            if (!best || dist.rooms < best.rooms || (dist.rooms === best.rooms && dist.stepsApprox < best.stepsApprox)) {
                best = dist;
            }
        }
        return best;
    },

    executeSpawn: function(spawn, candidate) {
        const sanitizeNamePrefix = (prefix, fallbackRole) => {
            const raw = String(prefix || `${fallbackRole || 'creep'}`);
            const safe = raw.replace(/[^a-zA-Z0-9_\-]/g, '_');
            if (safe.length === 0) return 'creep';
            return safe.slice(0, 70);
        };

        const base = sanitizeNamePrefix(candidate.namePrefix, candidate.role);
        const name = `${base}_${Game.time.toString(36)}_${Math.floor(Math.random() * 100)}`;
        const memory = Object.assign({}, candidate.memory || {});

        memory.spawnRoom = spawn.room.name;
        memory.room = candidate.homeRoom || memory.room;
        memory.contractId = candidate.contractId;

        if (spawn.room.name !== candidate.homeRoom) {
            memory.homeSpawnPos = getHomeSpawnPosition(memory.room);
            const travelTargetRoom = candidate.travelTargetRoom || candidate.targetRoom || null;
            const shouldTravelHomeFirst = !!memory.room && (!travelTargetRoom || travelTargetRoom === memory.room);

            if (candidate.bindMode === 'pool' || shouldTravelHomeFirst) {
                memory._travellingToHome = true;
                if (memory.travelTargetRoom) delete memory.travelTargetRoom;
            } else if (travelTargetRoom) {
                memory.travelTargetRoom = travelTargetRoom;
            }
        } else if (memory.homeSpawnPos) {
            delete memory.homeSpawnPos;
        }

        const result = spawn.spawnCreep(candidate.body, name, { memory });
        if (result === OK) {
            debug('spawner', `[GlobalSpawner] spawning ${name} in ${spawn.room.name} for ${candidate.homeRoom} contract=${candidate.contractId}`);
        } else {
            debug('spawner', `[GlobalSpawner] spawn failed ${spawn.name} result=${result} contract=${candidate.contractId}`);
        }
    }
};

