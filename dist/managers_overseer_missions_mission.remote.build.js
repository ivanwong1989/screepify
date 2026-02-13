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

        const MAX_REMOTE_SITES = 3;
        const STALE_SITE_TICKS = 2000;
        const buildStats = managerSpawner.checkBody('worker', context.budget);
        const workPerCreep = buildStats.work || 1;

        entries.forEach(({ name, entry, room: remoteRoom, enabled }) => {
            if (!enabled || !entry) return;

            let sites = [];
            if (remoteRoom) {
                sites = remoteRoom.find(FIND_CONSTRUCTION_SITES);
            } else if (Array.isArray(entry.sites) && entry.lastSites && (Game.time - entry.lastSites) <= STALE_SITE_TICKS) {
                sites = entry.sites;
            }

            if (!sites || sites.length === 0) return;

            const sorted = [...sites].sort((a, b) => {
                const aRatio = a.progressTotal > 0 ? (a.progress / a.progressTotal) : 0;
                const bRatio = b.progressTotal > 0 ? (b.progress / b.progressTotal) : 0;
                return aRatio - bRatio;
            });

            const selected = sorted.slice(0, Math.min(MAX_REMOTE_SITES, sorted.length));
            const sourceIds = Array.isArray(entry.sourcesInfo) ? entry.sourcesInfo.map(s => s.id) : [];
            const containerIds = Array.isArray(entry.sourcesInfo)
                ? entry.sourcesInfo.map(s => s.containerId).filter(id => id)
                : [];

            debug('mission.remote.build', `[RemoteBuild] ${room.name} -> ${name} targets=${selected.length}/${sites.length} ` +
                `workPerCreep=${workPerCreep}`);

            selected.forEach(site => {
                const pos = site.pos || { x: site.x, y: site.y, roomName: site.roomName };
                if (!pos || pos.x === undefined || pos.y === undefined || !pos.roomName) return;
                const targetPos = { x: pos.x, y: pos.y, roomName: pos.roomName };
                missions.push({
                    name: `remote:build:${site.id}`,
                    type: 'remote_build',
                    archetype: 'worker',
                    targetId: site.id,
                    targetPos: targetPos,
                    data: {
                        remoteRoom: name,
                        sourceIds: sourceIds,
                        containerIds: containerIds
                    },
                    requirements: {
                        archetype: 'worker',
                        count: 1,
                        spawnFromFleet: true
                    },
                    priority: 45
                });
            });
        });
    }
};
