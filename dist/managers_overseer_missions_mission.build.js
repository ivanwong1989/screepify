const managerSpawner = require('managers_spawner_manager.room.economy.spawner');

module.exports = {
    generate: function(room, intel, context, missions) {
        const { state, budget, getMissionCensus } = context;
        if (intel.constructionSites.length === 0 || state === 'EMERGENCY') return;

        const buildName = 'build:sites';
        const buildCensus = getMissionCensus(buildName);
        const buildStats = managerSpawner.checkBody('worker', budget);
        const buildTarget = 5;
        const workPerCreep = buildStats.work || 1;
        const desiredCount = Math.ceil(buildTarget / workPerCreep);

        let reqCount = 0;
        if (buildCensus.workParts >= buildTarget) {
            reqCount = Math.max(1, desiredCount);
        } else {
            const buildDeficit = Math.max(0, buildTarget - buildCensus.workParts);
            const buildNeeded = Math.ceil(buildDeficit / workPerCreep);
            reqCount = buildCensus.count + buildNeeded;
            if (reqCount === 0 && buildTarget > 0) reqCount = 1;
        }

        debug('mission.build', `[Build] ${room.name} count=${buildCensus.count} workParts=${buildCensus.workParts}/${buildTarget} ` +
            `workPerCreep=${workPerCreep} desired=${desiredCount} req=${reqCount}`);

        missions.push({
            name: buildName,
            type: 'build',
            archetype: 'worker',
            targetIds: intel.constructionSites.map(s => s.id),
            data: { sourceIds: intel.allEnergySources.map(s => s.id) },
            requirements: {
                archetype: 'worker',
                count: reqCount
            },
            priority: 60
        });
    }
};
