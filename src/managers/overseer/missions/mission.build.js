const managerSpawner = require('managers_spawner_manager.room.economy.spawner');

module.exports = {
    generate: function(room, intel, context, missions) {
        const { state, budget, getMissionCensus } = context;
        if (intel.constructionSites.length === 0 || state === 'EMERGENCY') return;

        const buildName = 'build:sites';
        const buildCensus = getMissionCensus(buildName);
        const buildStats = managerSpawner.checkBody('worker', budget);
        const buildTarget = 5;
        const buildDeficit = Math.max(0, buildTarget - buildCensus.work);
        const buildNeeded = Math.ceil(buildDeficit / (buildStats.work || 1));

        missions.push({
            name: buildName,
            type: 'build',
            archetype: 'worker',
            targetIds: intel.constructionSites.map(s => s.id),
            data: { sourceIds: intel.allEnergySources.map(s => s.id) },
            requirements: {
                archetype: 'worker',
                count: buildCensus.count + buildNeeded
            },
            priority: 60
        });
    }
};
