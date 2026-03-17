function getCandidateSpawnTier(candidate) {
    const role = candidate && candidate.role ? String(candidate.role) : '';
    const targetRoom = candidate && candidate.targetRoom ? candidate.targetRoom : null;
    const homeRoom = candidate && candidate.homeRoom ? candidate.homeRoom : null;

    if (role === 'miner' || role === 'hauler' || role === 'coreLaneHauler' || role === 'miningLaneHauler') return 0;

    const remoteByRole = role.indexOf('remote_') === 0;
    const remoteByTarget = !!(targetRoom && homeRoom && targetRoom !== homeRoom);
    if (remoteByRole || remoteByTarget) return 2;

    return 1;
}

module.exports = {
    run: function(allCandidates) {
        if (!allCandidates || allCandidates.length === 0) return;

        const spawnDistanceCache = require('managers_spawner_spawnDistanceCache');
        spawnDistanceCache.syncSpawnRegistry();
        spawnDistanceCache.enqueueMissingPairs();
        spawnDistanceCache.processQueue({ maxPairsPerTick: 2 });

        allCandidates.sort((a, b) => {
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

        let candidates = availableSpawns.filter(s => s.room.energyCapacityAvailable >= candidate.cost);
        const localSpawns = candidates.filter(s => s.room.name === candidate.homeRoom);

        const readyLocal = localSpawns.find(s => s.room.energyAvailable >= candidate.cost);
        if (readyLocal) return readyLocal;

        const homeRoom = Game.rooms[candidate.homeRoom];
        const homeSpawns = homeRoom ? homeRoom.find(FIND_MY_SPAWNS) : [];
        const remoteCandidates = candidates.filter(s => {
            if (s.room.name === candidate.homeRoom) return false;
            if (candidate.role === 'miner') return false;
            if (s.room.energyAvailable < candidate.cost) return false;
            if (s.room._opState === 'EMERGENCY') return false;

            if (homeSpawns.length === 0) {
                const distFallback = Game.map.getRoomLinearDistance(candidate.homeRoom, s.room.name);
                return distFallback <= 2;
            }

            let best = null;
            for (const homeSpawn of homeSpawns) {
                const dist = spawnDistanceCache.getDistance(homeSpawn.id, s.id);
                if (dist === undefined || dist === null) continue;
                if (!best || dist.rooms < best.rooms || (dist.rooms === best.rooms && dist.stepsApprox < best.stepsApprox)) {
                    best = dist;
                }
            }

            if (!best) return false;
            return best.rooms <= 2;
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
            if (candidate.bindMode === 'pool') {
                memory._travellingToHome = true;
            } else if (candidate.travelTargetRoom) {
                memory.travelTargetRoom = candidate.travelTargetRoom;
            } else if (candidate.targetRoom) {
                memory.travelTargetRoom = candidate.targetRoom;
            }
        }

        const result = spawn.spawnCreep(candidate.body, name, { memory });
        if (result === OK) {
            debug('spawner', `[GlobalSpawner] spawning ${name} in ${spawn.room.name} for ${candidate.homeRoom} contract=${candidate.contractId}`);
        } else {
            debug('spawner', `[GlobalSpawner] spawn failed ${spawn.name} result=${result} contract=${candidate.contractId}`);
        }
    }
};
