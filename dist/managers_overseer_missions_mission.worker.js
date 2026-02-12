module.exports = {
    generate: function(room, intel, context, missions) {
        const workerMissions = missions.filter(m =>
            m.archetype === 'worker' &&
            m.requirements &&
            m.requirements.spawnFromFleet
        );

        if (workerMissions.length === 0) return;

        const spawnable = workerMissions.filter(m => m.requirements.spawn !== false);
        const desiredCount = spawnable.reduce((sum, m) => sum + (m.requirements.count || 0), 0);
        if (desiredCount <= 0) return;

        const priority = spawnable.reduce((max, m) => Math.max(max, m.priority || 0), 0);

        debug('mission.worker', `[WorkerFleet] ${room.name} demand=${desiredCount} ` +
            `missions=${spawnable.length} priority=${priority}`);

        missions.push({
            name: 'worker:fleet',
            type: 'worker_fleet',
            archetype: 'worker',
            roleCensus: 'worker',
            requirements: {
                archetype: 'worker',
                count: desiredCount
            },
            priority: priority
        });
    }
};
