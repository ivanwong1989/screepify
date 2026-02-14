module.exports = {
    generate: function(room, intel, context, missions) {
        const workerMissions = missions.filter(m =>
            m.requirements &&
            m.requirements.spawnFromFleet
        );

        if (workerMissions.length === 0) return;

        const isFortify = (m) => {
            if (!m) return false;
            if (m.data && m.data.fortify) return true;
            if (typeof m.name === 'string' && m.name.startsWith('fortify:')) return true;
            return false;
        };

        const spawnable = workerMissions.filter(m => m.requirements.spawn !== false);
        const localMissions = spawnable.filter(m => m.archetype === 'worker' && !isFortify(m));
        const remoteMissions = spawnable.filter(m => m.archetype === 'remote_worker');
        const fortifyExists = workerMissions.some(m => m.archetype === 'worker' && isFortify(m));

        const localCount = localMissions.reduce((sum, m) => sum + (m.requirements.count || 0), 0);
        const FORTIFY_BONUS = 2;
        const fortifyBonus = fortifyExists ? FORTIFY_BONUS : 0;
        const totalLocalCount = localCount + fortifyBonus;
        const remoteDemand = remoteMissions.reduce((sum, m) => sum + (m.requirements.count || 0), 0);

        let remoteBuilderCount = 0;
        let remoteCap = 0;
        if (remoteDemand > 0) {
            const budget = (context && Number.isFinite(context.budget)) ? context.budget : (intel.energyCapacityAvailable || 0);
            const MAX_REMOTE_BUILDERS = 5;
            const CAPACITY_PER_BUILDER = 500;
            const capacityCap = Math.max(1, Math.floor(budget / CAPACITY_PER_BUILDER));
            remoteCap = Math.min(MAX_REMOTE_BUILDERS, capacityCap);
            remoteBuilderCount = Math.min(remoteDemand, remoteCap);
        }

        if (totalLocalCount > 0) {
            const localPriority = localMissions.reduce((max, m) => Math.max(max, m.priority || 0), 0);
            debug('mission.worker', `[WorkerFleet] ${room.name} demand=${totalLocalCount} ` +
                `base=${localCount} fortify=${fortifyBonus} missions=${localMissions.length} ` +
                `priority=${localPriority}`);

            missions.push({
                name: 'worker:fleet',
                type: 'worker_fleet',
                archetype: 'worker',
                roleCensus: 'worker',
                requirements: {
                    archetype: 'worker',
                    count: totalLocalCount
                },
                priority: localPriority
            });
        }

        if (remoteBuilderCount > 0) {
            const remotePriority = remoteMissions.reduce((max, m) => Math.max(max, m.priority || 0), 0);
            debug('mission.worker', `[RemoteWorkerFleet] ${room.name} demand=${remoteBuilderCount} ` +
                `remoteDemand=${remoteDemand} remoteCap=${remoteCap} ` +
                `missions=${remoteMissions.length} priority=${remotePriority}`);

            missions.push({
                name: 'remote_worker:fleet',
                type: 'remote_worker_fleet',
                archetype: 'remote_worker',
                roleCensus: 'remote_worker',
                requirements: {
                    archetype: 'remote_worker',
                    count: remoteBuilderCount
                },
                priority: remotePriority
            });
        }
    }
};
