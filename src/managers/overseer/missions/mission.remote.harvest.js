const remoteUtils = require('managers_overseer_utils_overseer.remote');

module.exports = {
    generate: function(room, intel, context, missions) {
        if (context.opState === 'EMERGENCY') return;

        const entries = remoteUtils.getRemoteEconomicContext(room, {
            opState: context.opState,
            maxScoutAge: 4000
        });

        const { getMissionCensus } = context;

        entries.forEach(({ name, entry, enabled }) => {
            if (!enabled || !entry || !Array.isArray(entry.sourcesInfo)) return;

            entry.sourcesInfo.forEach(source => {
                if (!source || !source.id) return;
                const hasContainer = !!(source.hasContainer || source.containerId);

                const missionName = `remote:harvest:${name}:${source.id}`;
                const census = getMissionCensus(missionName);

                const targetWork = 5;
                const availableSpaces = source.availableSpaces || 1;

                debug('mission.remote.harvest', `[RemoteHarvest] ${room.name} -> ${name} ${source.id} ` +
                    `count=${census.count} workParts=${census.workParts}/${targetWork} ` +
                    `maxCount=${availableSpaces}`);

                missions.push({
                    name: missionName,
                    type: 'remote_harvest',
                    archetype: 'remote_miner',
                    sourceId: source.id,
                    pos: new RoomPosition(source.x, source.y, name),
                    requirements: {
                        archetype: 'remote_miner',
                        requiredWork: targetWork,
                        minCount: 1,
                        maxCount: availableSpaces
                    },
                    data: {
                        remoteRoom: name,
                        sourcePos: { x: source.x, y: source.y, roomName: name },
                        containerId: hasContainer ? source.containerId : null,
                        containerPos: hasContainer ? (source.containerPos || null) : null,
                        mode: hasContainer ? 'static' : 'drop'
                    },
                    priority: 80,
                    census: census
                });
            });
        });
    }
};
