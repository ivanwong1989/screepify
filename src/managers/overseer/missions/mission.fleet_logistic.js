const managerSpawner = require('managers_spawner_manager.room.economy.spawner');

module.exports = {
    generate: function(room, intel, context, missions) {
        const { budget, efficientSources } = context;
        const enableHaulers = efficientSources && efficientSources.size > 0;

        if (enableHaulers) {
            // 0. Generate Fleet Mission (stable hauler spawn)
            const MAX_HAULER_CARRY_PARTS = 16;
            const MIN_CARRY_PER_SOURCE = 4;
            const LINKED_SOURCE_MIN_CARRY = 3;
            const ENERGY_PER_TICK = 10;
            const TRANSFER_BUFFER_TICKS = 2;
            const DISTANCE_SOFT_CAP = 14;
            const DISTANCE_SCALE_PER_TILE = 0.15;
            const EARLY_GAME_ENERGY_CAP = 800;
            const EARLY_GAME_HAULER_MULTIPLIER = 1.25;
            const LINK_SOURCE_RANGE = 2;
            const LINK_RECEIVER_RANGE = 3;

            const miningContainerIds = new Set(intel.sources.map(s => s.containerId).filter(id => id));
            const allContainers = intel.structures[STRUCTURE_CONTAINER] || [];
            const miningContainers = allContainers.filter(c => miningContainerIds.has(c.id));
            const miningContainersById = new Map(miningContainers.map(c => [c.id, c]));
            const spawns = intel.structures[STRUCTURE_SPAWN] || [];
            const storage = room.storage;

            const haulerStats = managerSpawner.checkBody('hauler', budget);
            const uncappedCarryParts = haulerStats.carry || 1;
            const carryParts = Math.min(uncappedCarryParts, MAX_HAULER_CARRY_PARTS);

            const haulTargets = storage ? [storage] : spawns;
            if (haulTargets.length > 0) {
                const links = intel.structures[STRUCTURE_LINK] || [];
                const hasReceiverLink = links.some(link =>
                    (storage && link.pos.inRangeTo(storage.pos, LINK_RECEIVER_RANGE)) ||
                    spawns.some(spawn => link.pos.inRangeTo(spawn.pos, LINK_RECEIVER_RANGE))
                );
                const sourcesWithLink = new Set();
                if (hasReceiverLink && links.length > 0) {
                    intel.sources.forEach(source => {
                        if (links.some(link => link.pos.inRangeTo(source.pos, LINK_SOURCE_RANGE))) {
                            sourcesWithLink.add(source.id);
                        }
                    });
                }

                const pathLengthCache = new Map();
                const getPathLength = (fromPos, toPos) => {
                    const key = `${fromPos.x},${fromPos.y}:${toPos.x},${toPos.y}`;
                    if (pathLengthCache.has(key)) return pathLengthCache.get(key);
                    const result = PathFinder.search(fromPos, { pos: toPos, range: 1 }, {
                        maxOps: 2000,
                        plainCost: 2,
                        swampCost: 10
                    });
                    const length = result.incomplete ? fromPos.getRangeTo(toPos) : result.path.length;
                    pathLengthCache.set(key, length);
                    return length;
                };

                const getClosestByPath = (fromPos, targets) => {
                    let best = null;
                    let bestLen = Infinity;
                    targets.forEach(t => {
                        const len = getPathLength(fromPos, t.pos);
                        if (len < bestLen) {
                            bestLen = len;
                            best = t;
                        }
                    });
                    return best;
                };

                if (!room.memory.logistics) room.memory.logistics = {};
                if (!room.memory.logistics.pathCache) {
                    room.memory.logistics.pathCache = { targetSignature: null, paths: {} };
                }
                const pathCache = room.memory.logistics.pathCache;
                const targetSignature = storage
                    ? `storage:${storage.id}`
                    : `spawns:${spawns.map(s => s.id).sort().join(',')}`;
                if (pathCache.targetSignature !== targetSignature) {
                    pathCache.targetSignature = targetSignature;
                    pathCache.paths = {};
                }

                const getCachedPath = (pickupId) => pathCache.paths[pickupId];
                const setCachedPath = (pickupId, entry) => { pathCache.paths[pickupId] = entry; };

                let totalRequiredCarryParts = 0;
                let linkedSourcesCount = 0;
                intel.sources.forEach(source => {
                    if (!efficientSources.has(source.id)) return;
                    const container = source.containerId ? miningContainersById.get(source.containerId) : null;
                    const pickupPos = container ? container.pos : source.pos;

                    const pickupId = container ? container.id : source.id;
                    const isLinkedSource = sourcesWithLink.has(source.id);
                    if (isLinkedSource) linkedSourcesCount += 1;

                    let requiredCarry = LINKED_SOURCE_MIN_CARRY;
                    const cached = getCachedPath(pickupId);
                    const cachedTarget = cached ? Game.getObjectById(cached.targetId) : null;
                    const useCached = !!cached &&
                        cached.pickupId === pickupId &&
                        cachedTarget &&
                        cached.targetSignature === targetSignature;

                    if (!isLinkedSource) {
                        let pathLen = 1;
                        if (useCached) {
                            pathLen = cached.pathLen;
                        } else {
                            const dropoff = storage ? storage : getClosestByPath(pickupPos, haulTargets);
                            pathLen = dropoff ? getPathLength(pickupPos, dropoff.pos) : 1;
                            if (dropoff) {
                                setCachedPath(pickupId, {
                                    pickupId,
                                    targetId: dropoff.id,
                                    pathLen,
                                    targetSignature
                                });
                            }
                        }
                        const roundTrip = (pathLen * 2) + TRANSFER_BUFFER_TICKS;
                        const distanceScale = 1 + Math.max(0, pathLen - DISTANCE_SOFT_CAP) * DISTANCE_SCALE_PER_TILE;
                        requiredCarry = Math.ceil((ENERGY_PER_TICK * roundTrip * distanceScale) / 50);
                    }
                    const minCarry = isLinkedSource ? LINKED_SOURCE_MIN_CARRY : MIN_CARRY_PER_SOURCE;
                    totalRequiredCarryParts += Math.max(minCarry, requiredCarry);
                });

                const isEarlyGame = (room.controller && room.controller.level <= 3) ||
                    (!storage && intel.energyCapacityAvailable <= EARLY_GAME_ENERGY_CAP);
                const scaledRequiredCarryParts = isEarlyGame
                    ? Math.ceil(totalRequiredCarryParts * EARLY_GAME_HAULER_MULTIPLIER)
                    : totalRequiredCarryParts;

                const minHaulers = Math.max(2, efficientSources.size);
                const desiredHaulers = Math.max(minHaulers, Math.ceil(scaledRequiredCarryParts / carryParts));

                debug('mission.logistics', `[LogisticsFleet] ${room.name} sources=${efficientSources.size} linkedSources=${linkedSourcesCount} ` +
                    `carryPerHauler=${carryParts} requiredCarry=${totalRequiredCarryParts} ` +
                    `scaledCarry=${scaledRequiredCarryParts} early=${isEarlyGame} desiredHaulers=${desiredHaulers}`);

                missions.push({
                    name: 'logistics:fleet',
                    type: 'hauler_fleet',
                    archetype: 'hauler',
                    roleCensus: 'hauler',
                    requirements: {
                        archetype: 'hauler',
                        count: desiredHaulers,
                        spawnFromFleet: true,
                        maxCarryParts: MAX_HAULER_CARRY_PARTS
                    },
                    priority: 85
                });
            }
        }

    }
};
