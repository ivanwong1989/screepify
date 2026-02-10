const managerSpawner = require('managers_manager.room.economy.spawner');

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
            const deficit = Math.max(0, targetWork - census.work);
            const neededNew = Math.ceil(deficit / (archStats.work || 1));
            let reqCount = Math.min(census.count + neededNew, source.availableSpaces);
            if (reqCount === 0 && targetWork > 0) reqCount = 1;

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
