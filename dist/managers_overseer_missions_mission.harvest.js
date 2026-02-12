const managerSpawner = require('managers_spawner_manager.room.economy.spawner');

module.exports = {
    generate: function(room, intel, context, missions) {
        const { state, budget, getMissionCensus, efficientSources } = context;
        const isEmergency = state === 'EMERGENCY';
        let availableHaulerCapacity = intel.haulerCapacity;

        intel.sources.forEach(source => {
            const isEfficient = efficientSources.has(source.id);
            const hasCap = availableHaulerCapacity >= 300;
            const canDropMine = (source.hasContainer || hasCap) && isEfficient;
            
            if (canDropMine && !source.hasContainer) availableHaulerCapacity -= 300;

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

            debug('mission.harvest', `[Harvest] ${room.name} ${source.id} mode=${canDropMine ? 'static' : 'mobile'} ` +
                `count=${census.count} workParts=${census.workParts}/${targetWork} ` +
                `workPerCreep=${workPerCreep} desired=${desiredCount} req=${reqCount} ` +
                `spaces=${source.availableSpaces}`);

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
                data: {
                    hasContainer: source.hasContainer,
                    containerId: source.containerId,
                    mode: canDropMine ? 'static' : 'mobile'
                },
                priority: isEmergency ? 1000 : 100
            });
        });
    }
};
