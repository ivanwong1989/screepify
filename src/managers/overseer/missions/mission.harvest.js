const managerSpawner = require('managers_spawner_manager.room.economy.spawner');

module.exports = {
    generate: function(room, intel, context, missions) {
        const { state, budget, getMissionCensus, efficientSources } = context;
        const isEmergency = state === 'EMERGENCY';
        let availableHaulerCapacity = intel.haulerCapacity;
        const spawns = intel.structures[STRUCTURE_SPAWN] || [];
        const extensions = intel.structures[STRUCTURE_EXTENSION] || [];
        const towers = intel.structures[STRUCTURE_TOWER] || [];
        const storage = room.storage;

        intel.sources.forEach(source => {
            const isEfficient = efficientSources.has(source.id);
            const hasCap = availableHaulerCapacity >= 300;
            const canDropMine = (source.hasContainer || hasCap) && isEfficient;
            
            if (canDropMine && !source.hasContainer) availableHaulerCapacity -= 300;

            const hasContainer = !!source.containerId;
            let mode = canDropMine ? 'static' : 'mobile';
            if (mode === 'static' && !hasContainer) mode = 'mobile';

            let containerId = hasContainer ? source.containerId : null;
            let dropoffIds = [];
            let fallback = 'none';
            let dropoffRange = 1;

            if (mode === 'static') {
                const linkId = source.linkId || null;
                if (linkId) dropoffIds.push(linkId);
                if (containerId) dropoffIds.push(containerId);
                fallback = 'none';
            } else {
                const spawnExt = [
                    ...spawns.filter(s => s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0).map(s => s.id),
                    ...extensions.filter(e => e.store && e.store.getFreeCapacity(RESOURCE_ENERGY) > 0).map(e => e.id)
                ];
                const towerIds = towers
                    .filter(t => t.store && t.store.getFreeCapacity(RESOURCE_ENERGY) >= 50)
                    .map(t => t.id);
                const storageIds = (storage && storage.store && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0)
                    ? [storage.id]
                    : [];
                dropoffIds = [...spawnExt, ...towerIds, ...storageIds];
                fallback = 'upgrade';
            }

            const missionName = `harvest:${source.id}`;
            const census = getMissionCensus(missionName);
            const archStats = managerSpawner.checkBody('miner', budget);
            
            const targetWork = 5;
            const workPerCreep = archStats.work || 1;
            const desiredCount = Math.min(Math.ceil(targetWork / workPerCreep), source.availableSpaces);

            let reqCount = 0;
            if (census.workParts >= targetWork) {
                // If we're already saturated on work parts, avoid locking in extra miners.
                reqCount = Math.max(1, desiredCount);
            } else {
                const deficit = Math.max(0, targetWork - census.workParts);
                const neededNew = Math.ceil(deficit / workPerCreep);
                reqCount = Math.min(census.count + neededNew, source.availableSpaces);
                if (reqCount === 0 && targetWork > 0) reqCount = 1;
            }

            debug('mission.harvest', `[Harvest] ${room.name} ${source.id} mode=${mode} ` +
                `count=${census.count} workParts=${census.workParts}/${targetWork} ` +
                `workPerCreep=${workPerCreep} desired=${desiredCount} req=${reqCount} ` +
                `spaces=${source.availableSpaces}`);

            const hasValidSource = !!source.id;
            const hasValidMode = mode === 'static' || mode === 'mobile';
            const hasValidStatic = mode !== 'static' || (containerId && dropoffIds.length > 0);
            const hasValidMobile = mode !== 'mobile' || Array.isArray(dropoffIds);
            if (!hasValidSource || !hasValidMode || !hasValidStatic || !hasValidMobile) {
                debug('mission.harvest', `[Harvest] ${room.name} ${source.id} blocked: invalid contract`);
                return;
            }

            missions.push({
                name: missionName,
                type: 'harvest',
                archetype: 'miner',
                sourceId: source.id,
                pos: source.pos,
                requirements: {
                    archetype: 'miner',
                    count: reqCount
                },
                spawnSlots: (() => {
                    const slots = [];
                    const count = Math.max(0, reqCount || 0);
                    for (let i = 0; i < count; i++) {
                        slots.push(`harvest:${room.name}:${source.id}:${i}`);
                    }
                    return slots;
                })(),
                data: {
                    sourceId: source.id,
                    mode: mode,
                    dropoffIds: dropoffIds,
                    fallback: fallback,
                    containerId: containerId,
                    dropoffRange: dropoffRange
                },
                priority: isEmergency ? 1000 : 100
            });
        });
    }
};
