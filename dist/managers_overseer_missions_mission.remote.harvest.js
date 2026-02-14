const managerSpawner = require('managers_spawner_manager.room.economy.spawner');
const remoteUtils = require('managers_overseer_utils_overseer.remote');

module.exports = {
    generate: function(room, intel, context, missions) {
        if (context.state === 'EMERGENCY') return;

        const entries = remoteUtils.getRemoteContext(room, {
            state: context.state,
            requireStorage: true,
            maxScoutAge: 4000
        });

        const { budget, getMissionCensus } = context;
        const minerStats = managerSpawner.checkBody('remote_miner', budget);
        const workPerCreep = minerStats.work || 1;

        entries.forEach(({ name, entry, enabled }) => {
            if (!enabled || !entry || !Array.isArray(entry.sourcesInfo)) return;

            entry.sourcesInfo.forEach(source => {
                if (!source || !source.id) return;
                if (!source.hasContainer && !source.containerId) return;

                const missionName = `remote:harvest:${name}:${source.id}`;
                const census = getMissionCensus(missionName);

                const targetWork = 5;
                const availableSpaces = source.availableSpaces || 1;
                const desiredCount = Math.min(Math.ceil(targetWork / workPerCreep), availableSpaces);

                let reqCount = 0;
                if (census.workParts >= targetWork) {
                    reqCount = Math.max(1, desiredCount);
                } else {
                    const deficit = Math.max(0, targetWork - census.workParts);
                    const neededNew = Math.ceil(deficit / workPerCreep);
                    reqCount = Math.min(census.count + neededNew, availableSpaces);
                    if (reqCount === 0 && targetWork > 0) reqCount = 1;
                }

                debug('mission.remote.harvest', `[RemoteHarvest] ${room.name} -> ${name} ${source.id} ` +
                    `count=${census.count} workParts=${census.workParts}/${targetWork} ` +
                    `workPerCreep=${workPerCreep} req=${reqCount}`);

                missions.push({
                    name: missionName,
                    type: 'remote_harvest',
                    archetype: 'remote_miner',
                    sourceId: source.id,
                    pos: new RoomPosition(source.x, source.y, name),
                    requirements: {
                        archetype: 'remote_miner',
                        count: reqCount
                    },
                    data: {
                        remoteRoom: name,
                        sourcePos: { x: source.x, y: source.y, roomName: name },
                        containerId: source.containerId,
                        containerPos: source.containerPos || null,
                        mode: 'static'
                    },
                    priority: 80,
                    census: census
                });
            });
        });
    }
};
