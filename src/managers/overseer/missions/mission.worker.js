module.exports = {
    generate: function(room, intel, context, missions) {
        const workerMissions = missions.filter(m =>
            m.archetype === 'worker' &&
            m.requirements &&
            m.requirements.spawnFromFleet
        );

        if (workerMissions.length === 0) return;

        const spawnable = workerMissions.filter(m => m.requirements.spawn !== false);
        const remoteBuildMissions = spawnable.filter(m => m.type === 'remote_build');
        const localMissions = spawnable.filter(m => m.type !== 'remote_build');

        const localCount = localMissions.reduce((sum, m) => sum + (m.requirements.count || 0), 0);
        const remoteDemand = remoteBuildMissions.reduce((sum, m) => sum + (m.requirements.count || 0), 0);

        let remoteBuilderCount = 0;
        if (remoteDemand > 0) {
            const budget = (context && Number.isFinite(context.budget)) ? context.budget : (intel.energyCapacityAvailable || 0);
            const MAX_REMOTE_BUILDERS = 5;
            const CAPACITY_PER_BUILDER = 1000;
            const capacityCap = Math.max(1, Math.floor(budget / CAPACITY_PER_BUILDER));
            const remoteCap = Math.min(MAX_REMOTE_BUILDERS, capacityCap);
            remoteBuilderCount = Math.min(remoteDemand, remoteCap);
        }

        const desiredCount = localCount + remoteBuilderCount;
        if (desiredCount <= 0) return;

        const priority = spawnable.reduce((max, m) => Math.max(max, m.priority || 0), 0);

        debug('mission.worker', `[WorkerFleet] ${room.name} demand=${desiredCount} ` +
            `local=${localCount} remoteDemand=${remoteDemand} remoteCap=${remoteBuilderCount} ` +
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
