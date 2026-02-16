const managerSpawner = require('managers_spawner_manager.room.economy.spawner');
const remoteUtils = require('managers_overseer_utils_overseer.remote');

const toRoomPosition = (pos) => {
    if (!pos || !pos.roomName) return null;
    const x = Number(pos.x);
    const y = Number(pos.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return new RoomPosition(x, y, pos.roomName);
};

module.exports = {
    generate: function(room, intel, context, missions) {
        if (context.state === 'EMERGENCY') return;
        if (!room.storage) return;

        const entries = remoteUtils.getRemoteContext(room, {
            state: context.state,
            requireStorage: true,
            maxScoutAge: 4000
        });

        const { budget, getMissionCensus } = context;
        const haulerStats = managerSpawner.checkBody('remote_hauler', budget);
        const MAX_REMOTE_HAULER_CARRY_PARTS = 8;
        const ENERGY_PER_TICK = 10;
        const TRANSFER_BUFFER_TICKS = 2;
        const DISTANCE_SOFT_CAP = 25;
        const DISTANCE_SCALE_PER_TILE = 0.002;
        const carryParts = Math.min(haulerStats.carry || 1, MAX_REMOTE_HAULER_CARRY_PARTS);

        if (!room.memory.overseer) room.memory.overseer = {};
        if (!room.memory.overseer.remoteHaulPathCache) {
            room.memory.overseer.remoteHaulPathCache = { targetSignature: null, paths: {} };
        }
        const pathCache = room.memory.overseer.remoteHaulPathCache;
        const targetSignature = `storage:${room.storage.id}`;
        if (pathCache.targetSignature !== targetSignature) {
            pathCache.targetSignature = targetSignature;
            pathCache.paths = {};
        }

        const pathLengthCache = new Map();
        const getPathLength = (fromPos, toPos) => {
            if (!fromPos || !toPos) return 1;
            const key = `${fromPos.roomName}:${fromPos.x},${fromPos.y}:${toPos.roomName}:${toPos.x},${toPos.y}`;
            if (pathLengthCache.has(key)) return pathLengthCache.get(key);
            const result = PathFinder.search(fromPos, { pos: toPos, range: 1 }, {
                maxOps: 4000,
                plainCost: 2,
                swampCost: 10
            });
            const length = result.incomplete ? fromPos.getRangeTo(toPos) : result.path.length;
            pathLengthCache.set(key, length);
            return length;
        };
        const getCachedPath = (pickupId) => pathCache.paths[pickupId];
        const setCachedPath = (pickupId, entry) => { pathCache.paths[pickupId] = entry; };

        entries.forEach(({ name, entry, enabled }) => {
            if (!enabled || !entry || !Array.isArray(entry.sourcesInfo)) return;

            entry.sourcesInfo.forEach(source => {
                if (!source || !source.containerId || !source.containerPos) return;

                const missionName = `remote:haul:${name}:${source.containerId}`;
                const census = getMissionCensus(missionName);

                const pickupPos = toRoomPosition(source.containerPos);
                const dropoffPos = room.storage.pos;
                const pickupId = source.containerId;
                let pathLen = 1;

                const cached = getCachedPath(pickupId);
                if (cached && cached.pickupId === pickupId) {
                    pathLen = cached.pathLen;
                } else if (pickupPos && dropoffPos) {
                    pathLen = getPathLength(pickupPos, dropoffPos);
                    setCachedPath(pickupId, { pickupId, pathLen });
                }

                const roundTrip = (pathLen * 2) + TRANSFER_BUFFER_TICKS;
                const distanceScale = 1 + Math.max(0, pathLen - DISTANCE_SOFT_CAP) * DISTANCE_SCALE_PER_TILE;
                const requiredCarry = Math.ceil((ENERGY_PER_TICK * roundTrip * distanceScale) / 50);
                const reqCount = Math.max(1, Math.ceil(requiredCarry / carryParts));

                debug('mission.remote.haul', `[RemoteHaul] ${room.name} -> ${name} container=${source.containerId} ` +
                    `path=${pathLen} carryParts=${carryParts} req=${reqCount}`);

                missions.push({
                    name: missionName,
                    type: 'remote_haul',
                    archetype: 'remote_hauler',
                    requirements: {
                        archetype: 'remote_hauler',
                        count: reqCount,
                        maxCarryParts: MAX_REMOTE_HAULER_CARRY_PARTS,
                        spawnFromFleet: true
                    },
                    data: {
                        remoteRoom: name,
                        pickupId: source.containerId,
                        pickupPos: source.containerPos,
                        dropoffId: room.storage.id,
                        dropoffPos: { x: room.storage.pos.x, y: room.storage.pos.y, roomName: room.storage.pos.roomName },
                        resourceType: RESOURCE_ENERGY
                    },
                    priority: 70,
                    census: census
                });
            });
        });
    }
};
