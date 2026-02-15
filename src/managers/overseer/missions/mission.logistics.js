const managerSpawner = require('managers_spawner_manager.room.economy.spawner');

module.exports = {
    generate: function(room, intel, context, missions) {
        const { state, budget, efficientSources } = context;
        const isEmergency = state === 'EMERGENCY';
        const enableHaulers = efficientSources.size > 0;

        if (!enableHaulers) return;

        const activeMissions = new Map();
        const coveredSources = new Set();
        const coveredSourceResources = new Set();
        const coveredTargets = new Set();

        const miningContainerIds = new Set(intel.sources.map(s => s.containerId).filter(id => id));
        const allContainers = intel.structures[STRUCTURE_CONTAINER] || [];
        const miningContainers = allContainers.filter(c => miningContainerIds.has(c.id));
        const nonMiningContainers = allContainers.filter(c => !miningContainerIds.has(c.id));
        const storage = room.storage;
        const terminal = room.terminal;
        const spawns = intel.structures[STRUCTURE_SPAWN] || [];

        const miningContainersById = new Map(miningContainers.map(c => [c.id, c]));

        // 0. Generate Fleet Mission
        const MAX_HAULER_CARRY_PARTS = 16;
        const MIN_CARRY_PER_SOURCE = 4;
        const LINKED_SOURCE_MIN_CARRY = 3;
        const ENERGY_PER_TICK = 10;
        const TRANSFER_BUFFER_TICKS = 2;
        const DISTANCE_SOFT_CAP = 10;
        const DISTANCE_SCALE_PER_TILE = 0.15;
        const EARLY_GAME_ENERGY_CAP = 800;
        const EARLY_GAME_HAULER_MULTIPLIER = 1.25;
        const LINK_SOURCE_RANGE = 2;
        const LINK_RECEIVER_RANGE = 3;

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

        debug('mission.logistics', `[Logistics] ${room.name} sources=${efficientSources.size} linkedSources=${linkedSourcesCount} ` +
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
                spawn: true,
                maxCarryParts: MAX_HAULER_CARRY_PARTS
            },
            priority: 85
        });

        // 1. Identify active hauling missions
        intel.myCreeps.forEach(c => {
            if (c.memory.missionName && c.memory.missionName.startsWith('haul:')) {
                const parts = c.memory.missionName.split(':');
                if (parts.length >= 3) {
                    const sourceId = parts[1];
                    const targetId = parts[2];
                    const resourceType = parts[3];
                    const source = Game.getObjectById(sourceId);
                    const target = Game.getObjectById(targetId);
                    
                    if (source && target) {
                        let type = 'misc';
                        if ([STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_TOWER].includes(target.structureType)) {
                            type = 'outflow';
                        } else if (source instanceof Resource || source instanceof Tombstone || source instanceof Ruin) {
                            type = 'scavenge';
                        } else if (target.structureType === STRUCTURE_STORAGE) {
                            if (source.structureType === STRUCTURE_LINK) {
                                type = 'link_out';
                            } else {
                                type = miningContainerIds.has(source.id) ? 'mining' : 'consolidation';
                            }
                        } else if (target.structureType === STRUCTURE_TERMINAL) {
                            type = 'terminal_stock';
                        } else if (target.structureType === STRUCTURE_CONTAINER) {
                            type = miningContainerIds.has(source.id) ? 'mining' : 'scavenge';
                        }

                        const mission = {
                            name: c.memory.missionName,
                            type: 'transfer',
                            archetype: 'hauler',
                            targetId: targetId,
                            data: { sourceId: sourceId, resourceType: resourceType },
                            requirements: { archetype: 'hauler', count: 1, spawn: false },
                            priority: this.getLogisticsPriority(type, target, isEmergency)
                        };
                        activeMissions.set(c.memory.missionName, mission);
                        coveredSources.add(sourceId);
                        if (resourceType) coveredSourceResources.add(`${sourceId}:${resourceType}`);
                        coveredTargets.add(targetId);
                    }
                }
            }
        });

        // 2. Generate New Missions
        const refillSinks = [
            ...(intel.structures[STRUCTURE_SPAWN] || []),
            ...(intel.structures[STRUCTURE_EXTENSION] || []),
            ...(intel.structures[STRUCTURE_TOWER] || [])
        ].filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);

        refillSinks.forEach(target => {
            if (coveredTargets.has(target.id)) return;
            this.addSupplyMission(activeMissions, target, isEmergency);
        });

        const inflowSinks = [
            ...(storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0 ? [storage] : []),
            ...nonMiningContainers.filter(c => c.store.getFreeCapacity(RESOURCE_ENERGY) > 0)
        ];

        if (inflowSinks.length > 0) {
            const scavengeSources = [
                ...intel.dropped.filter(r => r.resourceType === RESOURCE_ENERGY && r.amount > 100),
                ...intel.ruins.filter(r => r.store[RESOURCE_ENERGY] > 0),
                ...intel.tombstones.filter(t => t.store[RESOURCE_ENERGY] > 0)
            ];
            scavengeSources.forEach(source => {
                if (coveredSources.has(source.id)) return;
                const bestSink = source.pos.findClosestByRange(inflowSinks);
                if (bestSink) this.addLogisticsMission(activeMissions, source, bestSink, isEmergency, 'scavenge');
            });

            const scavengeStores = [
                ...intel.ruins,
                ...intel.tombstones
            ];
            scavengeStores.forEach(source => {
                const store = source && source.store ? source.store : null;
                if (!store) return;
                for (const resourceType in store) {
                    if (resourceType === RESOURCE_ENERGY) continue;
                    if ((store[resourceType] || 0) <= 0) continue;
                    const key = `${source.id}:${resourceType}`;
                    if (coveredSourceResources.has(key)) continue;
                    const bestSink = source.pos.findClosestByRange(inflowSinks);
                    if (bestSink) this.addLogisticsMission(activeMissions, source, bestSink, isEmergency, 'scavenge', resourceType);
                }
            });

            miningContainers.filter(c => c.store[RESOURCE_ENERGY] >= (carryParts * 50)).forEach(source => {
                if (coveredSources.has(source.id)) return;
                const bestSink = source.pos.findClosestByRange(inflowSinks);
                if (bestSink) this.addLogisticsMission(activeMissions, source, bestSink, isEmergency, 'mining');
            });
        }

        if (storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            nonMiningContainers.filter(c => c.store[RESOURCE_ENERGY] >= 500 && c.id !== intel.controllerContainerId).forEach(source => {
                if (coveredSources.has(source.id)) return;
                this.addLogisticsMission(activeMissions, source, storage, isEmergency, 'consolidation');
            });

            links.filter(l => l.store[RESOURCE_ENERGY] > 0 && (l.pos.inRangeTo(storage.pos, 3) || spawns.some(s => l.pos.inRangeTo(s.pos, 3)))).forEach(link => {
                if (coveredSources.has(link.id)) return;
                if (room.controller && link.pos.inRangeTo(room.controller.pos, 3)) return;
                this.addLogisticsMission(activeMissions, link, storage, isEmergency, 'link_out');
            });
        }

        for (const m of activeMissions.values()) missions.push(m);
    },

    addLogisticsMission: function(activeMissions, source, target, isEmergency, type, resourceType) {
        const baseName = `haul:${source.id}:${target.id}`;
        const missionName = resourceType ? `${baseName}:${resourceType}` : baseName;
        if (activeMissions.has(missionName)) return;
        activeMissions.set(missionName, {
            name: missionName,
            type: 'transfer',
            archetype: 'hauler',
            targetId: target.id,
            data: { sourceId: source.id, resourceType: resourceType },
            requirements: { archetype: 'hauler', count: 1, spawn: false },
            priority: this.getLogisticsPriority(type, target, isEmergency)
        });
    },

    addSupplyMission: function(activeMissions, target, isEmergency) {
        const missionName = `supply:${target.id}`;
        if (activeMissions.has(missionName)) return;
        activeMissions.set(missionName, {
            name: missionName,
            type: 'transfer',
            archetype: 'hauler',
            targetId: target.id,
            data: { resourceType: RESOURCE_ENERGY, mode: 'supply' },
            requirements: { archetype: 'hauler', count: 1, spawn: false },
            priority: this.getLogisticsPriority('outflow', target, isEmergency)
        });
    },

    getLogisticsPriority: function(type, target, isEmergency) {
        if (type === 'outflow') {
            if (target.structureType === STRUCTURE_TOWER) return isEmergency ? 950 : 95;
            if (target.structureType === STRUCTURE_SPAWN || target.structureType === STRUCTURE_EXTENSION) return isEmergency ? 900 : 90;
            return 50;
        }
        if (type === 'link_out') return 55;
        if (type === 'scavenge') return 45;
        if (type === 'mining') return 30;
        if (type === 'terminal_stock') return 20;
        return 10;
    }
};
