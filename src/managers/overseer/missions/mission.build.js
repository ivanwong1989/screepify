const managerSpawner = require('managers_spawner_manager.room.economy.spawner');
const resolveBuildTarget = require('task_resolve_resolveBuildTarget');

module.exports = {
    generate: function(room, intel, context, missions) {
        const { state, budget } = context;
        if (intel.constructionSites.length === 0 || state === 'EMERGENCY') return;

        const buildStats = managerSpawner.checkBody('worker', budget);
        const buildTarget = 5;
        const workPerCreep = buildStats.work || 1;
        const desiredCount = Math.max(1, Math.ceil(buildTarget / workPerCreep));

        const res = resolveBuildTarget(room, intel);
        if (!res) return;
        const targetId = res.targetId;
        const queue = res.queue;

        const byId = new Map(intel.constructionSites.map(s => [s.id, s]));
        const site = byId.get(targetId);
        if (!site) return;

        debug('mission.build', `[Build] ${room.name} target=1/${intel.constructionSites.length} ` +
            `queue=${queue.length} workPerCreep=${workPerCreep} desired=${desiredCount}`);

        missions.push({
            name: `build:${site.id}`,
            type: 'build',
            archetype: 'worker',
            targetId: site.id,
            data: { sourceIds: intel.allEnergySources.map(s => s.id) },
            requirements: {
                archetype: 'worker',
                count: desiredCount,
                spawnFromFleet: true
            },
            priority: 60
        });
    }
};
