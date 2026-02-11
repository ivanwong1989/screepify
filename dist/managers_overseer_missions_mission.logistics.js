const managerSpawner = require('managers_spawner_manager.room.economy.spawner');

module.exports = {
    generate: function(room, intel, context, missions) {
        const { state, budget, efficientSources } = context;
        const isEmergency = state === 'EMERGENCY';
        const enableHaulers = efficientSources.size > 0;

        if (!enableHaulers) return;

        const activeMissions = new Map();
        const coveredSources = new Set();
        const coveredTargets = new Set();

        // 0. Generate Fleet Mission
        const haulerStats = managerSpawner.checkBody('hauler', budget);
        const carryParts = haulerStats.carry || 1;
        const partsPerSource = 14; 
        const totalNeededParts = intel.sources.length * partsPerSource;
        const desiredHaulers = Math.max(2, Math.ceil(totalNeededParts / carryParts));

        missions.push({
            name: 'logistics:fleet',
            type: 'hauler_fleet',
            archetype: 'hauler',
            roleCensus: 'hauler',
            requirements: { archetype: 'hauler', count: desiredHaulers, spawn: true },
            priority: 85
        });

        const miningContainerIds = new Set(intel.sources.map(s => s.containerId).filter(id => id));
        const allContainers = intel.structures[STRUCTURE_CONTAINER] || [];
        const miningContainers = allContainers.filter(c => miningContainerIds.has(c.id));
        const nonMiningContainers = allContainers.filter(c => !miningContainerIds.has(c.id));
        const storage = room.storage;

        // 1. Identify active hauling missions
        intel.myCreeps.forEach(c => {
            if (c.memory.missionName && c.memory.missionName.startsWith('haul:')) {
                const parts = c.memory.missionName.split(':');
                if (parts.length === 3) {
                    const sourceId = parts[1];
                    const targetId = parts[2];
                    const source = Game.getObjectById(sourceId);
                    const target = Game.getObjectById(targetId);
                    
                    if (source && target) {
                        let type = 'misc';
                        if ([STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_TOWER].includes(target.structureType)) {
                            type = 'outflow';
                        } else if (source instanceof Resource || source instanceof Tombstone || source instanceof Ruin) {
                            type = 'scavenge';
                        } else if (target.structureType === STRUCTURE_STORAGE) {
                            type = miningContainerIds.has(source.id) ? 'mining' : 'consolidation';
                        } else if (target.structureType === STRUCTURE_CONTAINER) {
                            type = miningContainerIds.has(source.id) ? 'mining' : 'scavenge';
                        }

                        const mission = {
                            name: c.memory.missionName,
                            type: 'transfer',
                            archetype: 'hauler',
                            targetId: targetId,
                            data: { sourceId: sourceId },
                            requirements: { archetype: 'hauler', count: 1, spawn: false },
                            priority: this.getLogisticsPriority(type, target, isEmergency)
                        };
                        activeMissions.set(c.memory.missionName, mission);
                        coveredSources.add(sourceId);
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

        const refillSources = [
            ...(storage && storage.store[RESOURCE_ENERGY] > 0 ? [storage] : []),
            ...allContainers.filter(c => c.store[RESOURCE_ENERGY] > 0)
        ];

        refillSinks.forEach(target => {
            if (coveredTargets.has(target.id)) return;
            const bestSource = target.pos.findClosestByRange(refillSources);
            if (bestSource) {
                this.addLogisticsMission(activeMissions, bestSource, target, isEmergency, 'outflow');
            }
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

            miningContainers.filter(c => c.store[RESOURCE_ENERGY] >= 500).forEach(source => {
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
        }

        for (const m of activeMissions.values()) missions.push(m);
    },

    addLogisticsMission: function(activeMissions, source, target, isEmergency, type) {
        const missionName = `haul:${source.id}:${target.id}`;
        if (activeMissions.has(missionName)) return;
        activeMissions.set(missionName, {
            name: missionName,
            type: 'transfer',
            archetype: 'hauler',
            targetId: target.id,
            data: { sourceId: source.id },
            requirements: { archetype: 'hauler', count: 1, spawn: false },
            priority: this.getLogisticsPriority(type, target, isEmergency)
        });
    },

    getLogisticsPriority: function(type, target, isEmergency) {
        if (type === 'outflow') {
            if (target.structureType === STRUCTURE_TOWER) return isEmergency ? 950 : 95;
            if (target.structureType === STRUCTURE_SPAWN || target.structureType === STRUCTURE_EXTENSION) return isEmergency ? 900 : 90;
            return 50;
        }
        if (type === 'scavenge') return 45;
        if (type === 'mining') return 30;
        return 10;
    }
};
