const managerSpawner = require('managers_spawner_manager.room.economy.spawner');
const heap = require('utils_heap');

module.exports = {
    generate: function(room, intel, context, missions) {
        const { budget, efficientSources } = context;
        const enableHaulers = efficientSources && efficientSources.size > 0;

        if (!enableHaulers) return;

        // 0. Generate Fleet Mission (stable hauler spawn)
        const MAX_HAULER_CARRY_PARTS = 16;
        const MIN_CARRY_PER_SOURCE = 4;
        const LINKED_SOURCE_MIN_CARRY = 3;
        const ENERGY_PER_TICK = 10;
        const TRANSFER_BUFFER_TICKS = 2;
        const DISTANCE_SOFT_CAP = 17;
        const DISTANCE_SCALE_PER_TILE = 0.1;
        const EARLY_GAME_ENERGY_CAP = 500;
        const EARLY_GAME_HAULER_MULTIPLIER = 1.01;
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
        if (haulTargets.length === 0) return;

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

        // ============================================================
        // HEAP PATH CACHE (migrated from room.memory.logistics.pathCache)
        // ============================================================
        // Old shape (in Memory):
        //   room.memory.logistics.pathCache = { targetSignature: null, paths: { [pickupId]: {..} } }
        //
        // New shape (in heap):
        //   heap.getStore('fleetLogisticsPathCache').rooms[roomName] = { targetSignature, paths, lastPrune }
        //
        // This is volatile by design; it saves CPU/Memory serialization cost.
        const root = heap.getStore('fleetLogisticsPathCache');
        if (!root.rooms) root.rooms = Object.create(null);

        const cache =
            root.rooms[room.name] ||
            (root.rooms[room.name] = {
                targetSignature: null,
                paths: Object.create(null),
                lastPrune: 0
            });

        const targetSignature = storage
            ? `storage:${storage.id}`
            : `spawns:${spawns.map(s => s.id).sort().join(',')}`;

        if (cache.targetSignature !== targetSignature) {
            cache.targetSignature = targetSignature;
            cache.paths = Object.create(null);
        }

        const getCachedPath = (pickupId) => cache.paths[pickupId];
        const setCachedPath = (pickupId, entry) => { cache.paths[pickupId] = entry; };

        // Track which pickupIds we actually used this tick, for pruning.
        const usedPickupIds = new Set();

        let totalRequiredCarryParts = 0;
        let linkedSourcesCount = 0;

        intel.sources.forEach(source => {
            if (!efficientSources.has(source.id)) return;

            const container = source.containerId ? miningContainersById.get(source.containerId) : null;
            const pickupPos = container ? container.pos : source.pos;

            const pickupId = container ? container.id : source.id;
            usedPickupIds.add(pickupId);

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

        // Prune heap cache occasionally:
        // - Remove entries not used anymore (pickup ids that disappeared / no longer efficient)
        // - Cap number of cached keys to prevent heap bloat across long runs
        const PRUNE_EVERY = 500;
        const MAX_KEYS = 1000;

        if ((Game.time - (cache.lastPrune || 0)) >= PRUNE_EVERY) {
            cache.lastPrune = Game.time;

            // Remove dead keys
            for (const pickupId in cache.paths) {
                if (!usedPickupIds.has(pickupId)) delete cache.paths[pickupId];
            }

            // Cap size (best-effort)
            const keys = Object.keys(cache.paths);
            if (keys.length > MAX_KEYS) {
                // Remove arbitrary overflow (no strong ordering needed; this is just to cap heap growth)
                const removeN = keys.length - MAX_KEYS;
                for (let i = 0; i < removeN; i++) delete cache.paths[keys[i]];
            }
        }

        const isEarlyGame =
            (room.controller && room.controller.level < 2) ||
            (!storage && intel.energyCapacityAvailable <= EARLY_GAME_ENERGY_CAP);

        const scaledRequiredCarryParts = isEarlyGame
            ? Math.ceil(totalRequiredCarryParts * EARLY_GAME_HAULER_MULTIPLIER)
            : totalRequiredCarryParts;

        const minHaulers = Math.max(2, efficientSources.size);
        const desiredHaulers = Math.max(minHaulers, Math.ceil(scaledRequiredCarryParts / carryParts));

        debug(
            'mission.logistics',
            `[LogisticsFleet] ${room.name} sources=${efficientSources.size} linkedSources=${linkedSourcesCount} ` +
            `carryPerHauler=${carryParts} requiredCarry=${totalRequiredCarryParts} ` +
            `scaledCarry=${scaledRequiredCarryParts} early=${isEarlyGame} desiredHaulers=${desiredHaulers}`
        );

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
};