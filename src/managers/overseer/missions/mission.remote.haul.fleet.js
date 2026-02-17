const MAX_REMOTE_HAULER_CARRY_PARTS = 8;

module.exports = {
    generate: function(room, intel, context, missions) {
        const haulMissions = missions.filter(m =>
            m &&
            m.requirements &&
            m.requirements.spawnFromFleet &&
            m.archetype === 'remote_hauler'
        );

        if (haulMissions.length === 0) return;

        const remoteDemand = haulMissions.reduce((sum, m) => sum + (m.requirements.count || 0), 0);
        if (remoteDemand <= 0) return;

        const remotePriority = haulMissions.reduce((max, m) => Math.max(max, m.priority || 0), 0);

        debug('mission.remote.haul', `[RemoteHaulerFleet] ${room.name} demand=${remoteDemand} missions=${haulMissions.length} priority=${remotePriority}`);

        missions.push({
            name: 'remote_hauler:fleet',
            type: 'remote_hauler_fleet',
            archetype: 'remote_hauler',
            roleCensus: 'remote_hauler',
            requirements: {
                archetype: 'remote_hauler',
                count: remoteDemand,
                maxCarryParts: MAX_REMOTE_HAULER_CARRY_PARTS,
                spawn: false
            },
            priority: remotePriority
        });
    }
};
