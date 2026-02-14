const managerSpawner = require('managers_spawner_manager.room.economy.spawner');
const remoteUtils = require('managers_overseer_utils_overseer.remote');

module.exports = {
    generate: function(room, intel, context, missions) {
        if (context.state === 'EMERGENCY') return;
        if (!room.storage) return;

        const entries = remoteUtils.getRemoteContext(room, {
            state: context.state,
            requireStorage: true,
            maxScoutAge: 4000
        });

        const { budget, getMissionCensus } = context;
        const haulerStats = managerSpawner.checkBody('remote_hauler', budget);
        const carryParts = haulerStats.carry || 1;
        const MAX_REMOTE_HAULER_CARRY_PARTS = 5;

        entries.forEach(({ name, entry, enabled }) => {
            if (!enabled || !entry || !Array.isArray(entry.sourcesInfo)) return;

            entry.sourcesInfo.forEach(source => {
                if (!source || !source.containerId || !source.containerPos) return;

                const missionName = `remote:haul:${name}:${source.containerId}`;
                const census = getMissionCensus(missionName);

                const reqCount = 1;

                debug('mission.remote.haul', `[RemoteHaul] ${room.name} -> ${name} container=${source.containerId} ` +
                    `carryParts=${carryParts} req=${reqCount}`);

                missions.push({
                    name: missionName,
                    type: 'remote_haul',
                    archetype: 'remote_hauler',
                    requirements: {
                        archetype: 'remote_hauler',
                        count: reqCount,
                        maxCarryParts: MAX_REMOTE_HAULER_CARRY_PARTS,
                        spawnFromFleet: true
                    },
                    data: {
                        remoteRoom: name,
                        pickupId: source.containerId,
                        pickupPos: source.containerPos,
                        dropoffId: room.storage.id,
                        dropoffPos: { x: room.storage.pos.x, y: room.storage.pos.y, roomName: room.storage.pos.roomName },
                        resourceType: RESOURCE_ENERGY
                    },
                    priority: 70,
                    census: census
                });
            });
        });
    }
};
