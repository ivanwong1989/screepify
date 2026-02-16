const managerSpawner = require('managers_spawner_manager.room.economy.spawner');
const remoteUtils = require('managers_overseer_utils_overseer.remote');

module.exports = {
    generate: function(room, intel, context, missions) {
        if (context.state === 'EMERGENCY') return;

        if (!room.memory.overseer) room.memory.overseer = {};
        if (!room.memory.overseer.remoteBuildCache) room.memory.overseer.remoteBuildCache = {};

        const entries = remoteUtils.getRemoteContext(room, {
            state: context.state,
            requireStorage: true,
            maxScoutAge: 4000
        });

        // Check for newly claimed rooms (often in skipRooms or filtered out of remote context)
        // We want to help build spawn and early infrastructure until RCL 2
        const remoteMem = room.memory.overseer.remote || {};
        const candidates = new Set([
            ...(remoteMem.skipRooms || []),
            ...Object.keys(remoteMem.rooms || {})
        ]);
        const existingNames = new Set(entries.map(e => e.name));

        candidates.forEach(roomName => {
            if (existingNames.has(roomName)) return;

            const remoteRoom = Game.rooms[roomName];
            if (remoteRoom && remoteRoom.controller && remoteRoom.controller.my && remoteRoom.controller.level < 2) {
                const sources = remoteRoom.find(FIND_SOURCES);
                const sourcesInfo = sources.map(s => ({ id: s.id, x: s.pos.x, y: s.pos.y }));
                
                entries.push({
                    name: roomName,
                    entry: { sourcesInfo },
                    room: remoteRoom,
                    enabled: true
                });
                existingNames.add(roomName);
            }
        });

        const MAX_REMOTE_SITES = 3;
        const REMOTE_SCAN_INTERVAL = 25;
        const STALE_SITE_TICKS = 2000;
        const buildStats = managerSpawner.checkBody('remote_worker', context.budget);
        const workPerCreep = buildStats.work || 1;

        entries.forEach(({ name, entry, room: remoteRoom, enabled }) => {
            if (!enabled || !entry) return;

            let sites = [];
            if (remoteRoom) {
                sites = remoteRoom.find(FIND_CONSTRUCTION_SITES);
            } else if (Array.isArray(entry.sites) && entry.lastSites && (Game.time - entry.lastSites) <= STALE_SITE_TICKS) {
                sites = entry.sites;
            }

            const cacheRoot = room.memory.overseer.remoteBuildCache;
            if (!cacheRoot[name]) cacheRoot[name] = { lastScan: 0, targetIds: [] };
            const cache = cacheRoot[name];
            const now = Game.time;
            const shouldScan = !cache.lastScan || (now - cache.lastScan) >= REMOTE_SCAN_INTERVAL;

            if (!sites || sites.length === 0) {
                cache.targetIds = [];
                cache.lastScan = now;
                return;
            }

            let selected = null;
            if (!shouldScan && cache.targetIds && cache.targetIds.length > 0) {
                const byId = new Map(sites.map(s => [s.id, s]));
                const cachedTargets = cache.targetIds.map(id => byId.get(id)).filter(s => s);
                if (cachedTargets.length > 0) selected = cachedTargets;
            }

            if (!selected) {
                const sorted = [...sites].sort((a, b) => {
                    const aRatio = a.progressTotal > 0 ? (a.progress / a.progressTotal) : 0;
                    const bRatio = b.progressTotal > 0 ? (b.progress / b.progressTotal) : 0;
                    return aRatio - bRatio;
                });

                selected = sorted.slice(0, Math.min(MAX_REMOTE_SITES, sorted.length));
                cache.targetIds = selected.map(s => s.id);
                cache.lastScan = now;
            }
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
                    archetype: 'remote_worker',
                    targetId: site.id,
                    targetPos: targetPos,
                    data: {
                        remoteRoom: name,
                        sourceIds: sourceIds,
                        containerIds: containerIds
                    },
                    requirements: {
                        archetype: 'remote_worker',
                        count: 1,
                        spawnFromFleet: true
                    },
                    priority: 45
                });
            });
        });
    }
};
