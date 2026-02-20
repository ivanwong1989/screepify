const managerSpawner = require('managers_spawner_manager.room.economy.spawner');
const managerTerminal = require('managers_structures_manager.terminal');

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

        const MAX_HAULER_CARRY_PARTS = 16;

        const haulerStats = managerSpawner.checkBody('hauler', budget);
        const uncappedCarryParts = haulerStats.carry || 1;
        const carryParts = Math.min(uncappedCarryParts, MAX_HAULER_CARRY_PARTS);

        const haulTargets = storage ? [storage] : spawns;
        if (haulTargets.length === 0) return;

        const links = intel.structures[STRUCTURE_LINK] || [];

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

            miningContainers.filter(c => c.store[RESOURCE_ENERGY] >= (carryParts * 50)).forEach(source => {
                if (coveredSources.has(source.id)) return;
                const bestSink = source.pos.findClosestByRange(inflowSinks);
                if (bestSink) this.addLogisticsMission(activeMissions, source, bestSink, isEmergency, 'mining');
            });
        }

        if (storage && terminal) {
            const baseCfg = managerTerminal.getConfig();
            const roomOverride = (baseCfg.rooms && baseCfg.rooms[room.name]) || null;
            const roomCfg = roomOverride ? Object.assign({}, baseCfg, roomOverride) : baseCfg;
            const target = roomCfg.terminalEnergyTarget || 0;

            if (target > 0) {
                const cur = terminal.store[RESOURCE_ENERGY] || 0;
                if (cur < target) {
                    const stor = storage.store[RESOURCE_ENERGY] || 0;
                    if (stor > 0) {
                        const need = Math.min(target - cur, stor);
                        if (need > 0) {
                            const missionName = `haul:${storage.id}:${terminal.id}:${RESOURCE_ENERGY}`;
                            if (!coveredTargets.has(terminal.id) && !activeMissions.has(missionName)) {
                                this.addLogisticsMission(activeMissions, storage, terminal, isEmergency, 'terminal_stock', RESOURCE_ENERGY);
                                debug('mission.logistics', `[TerminalStock] ${room.name} refill terminal energy cur=${cur} target=${target} need=${need}`);
                            }
                        }
                    }
                }
            }
        }

        const mineralTarget = terminal || storage;
        if (mineralTarget) {
            const targetType = terminal ? 'terminal_stock' : 'consolidation';

            const allStructureLists = Object.values(intel.structures || {});
            const seenStructures = new Set();
            allStructureLists.forEach(list => {
                if (!Array.isArray(list)) return;
                list.forEach(source => {
                    if (!source || !source.store) return;
                    if (source.id === mineralTarget.id) return;
                    if (source.structureType === STRUCTURE_LAB) return;
                    if (seenStructures.has(source.id)) return;
                    seenStructures.add(source.id);
                    for (const resourceType in source.store) {
                        if (resourceType === RESOURCE_ENERGY) continue;
                        if ((source.store[resourceType] || 0) <= 0) continue;
                        const key = `${source.id}:${resourceType}`;
                        if (coveredSourceResources.has(key)) continue;
                        this.addLogisticsMission(activeMissions, source, mineralTarget, isEmergency, targetType, resourceType);
                    }
                });
            });

            intel.dropped.forEach(source => {
                if (!source || source.resourceType === RESOURCE_ENERGY || source.amount <= 0) return;
                const key = `${source.id}:${source.resourceType}`;
                if (coveredSourceResources.has(key)) return;
                this.addLogisticsMission(activeMissions, source, mineralTarget, isEmergency, 'scavenge', source.resourceType);
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
                    this.addLogisticsMission(activeMissions, source, mineralTarget, isEmergency, 'scavenge', resourceType);
                }
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
