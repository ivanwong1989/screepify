const managerSpawner = require('managers_spawner_manager.room.economy.spawner');

module.exports = {
    generate: function(room, intel, context, missions) {
        const { state, budget } = context;
        if (intel.constructionSites.length === 0 || state === 'EMERGENCY') return;

        const buildStats = managerSpawner.checkBody('worker', budget);
        const buildTarget = 5;
        const workPerCreep = buildStats.work || 1;
        const desiredCount = Math.ceil(buildTarget / workPerCreep);
        const targetCount = Math.min(desiredCount, intel.constructionSites.length);
        if (targetCount === 0) return;

        const sortedTargets = [...intel.constructionSites].sort((a, b) => {
            const aRatio = a.progressTotal > 0 ? (a.progress / a.progressTotal) : 0;
            const bRatio = b.progressTotal > 0 ? (b.progress / b.progressTotal) : 0;
            return aRatio - bRatio;
        });
        const selectedTargets = sortedTargets.slice(0, targetCount);

        debug('mission.build', `[Build] ${room.name} targets=${targetCount}/${intel.constructionSites.length} ` +
            `workPerCreep=${workPerCreep} desired=${desiredCount}`);

        selectedTargets.forEach(site => {
            missions.push({
                name: `build:${site.id}`,
                type: 'build',
                archetype: 'worker',
                targetId: site.id,
                data: { sourceIds: intel.allEnergySources.map(s => s.id) },
                requirements: {
                    archetype: 'worker',
                    count: 1,
                    spawnFromFleet: true
                },
                priority: 60
            });
        });
    }
};
