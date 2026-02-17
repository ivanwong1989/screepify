const managerSpawner = require('managers_spawner_manager.room.economy.spawner');
const remoteUtils = require('managers_overseer_utils_overseer.remote');

module.exports = {
    generate: function(room, intel, context, missions) {
        if (context.state === 'EMERGENCY') return;

        if (!room.memory.overseer) room.memory.overseer = {};
        if (!room.memory.overseer.remoteRepairCache) room.memory.overseer.remoteRepairCache = {};

        const entries = remoteUtils.getRemoteEconomicContext(room, {
            state: context.state,
            requireStorage: true,
            maxScoutAge: 4000
        });

        const MAX_REMOTE_TARGETS = 3;
        const REMOTE_SCAN_INTERVAL = 25;
        const STALE_TARGET_TICKS = 2000;
        const repairStats = managerSpawner.checkBody('remote_worker', context.budget);
        const workPerCreep = repairStats.work || 1;

        entries.forEach(({ name, entry, room: remoteRoom, enabled }) => {
            if (!enabled || !entry) return;

            let targets = [];
            if (remoteRoom) {
                targets = remoteRoom.find(FIND_STRUCTURES, {
                    filter: s => (s.structureType === STRUCTURE_ROAD || s.structureType === STRUCTURE_CONTAINER) &&
                        s.hits < s.hitsMax
                });
            } else if (Array.isArray(entry.repairs) && entry.lastRepairs && (Game.time - entry.lastRepairs) <= STALE_TARGET_TICKS) {
                targets = entry.repairs;
            }

            const cacheRoot = room.memory.overseer.remoteRepairCache;
            if (!cacheRoot[name]) cacheRoot[name] = { lastScan: 0, targetIds: [] };
            const cache = cacheRoot[name];
            const now = Game.time;
            const shouldScan = !cache.lastScan || (now - cache.lastScan) >= REMOTE_SCAN_INTERVAL;

            if (!targets || targets.length === 0) {
                cache.targetIds = [];
                cache.lastScan = now;
                return;
            }

            let selected = null;
            if (!shouldScan && cache.targetIds && cache.targetIds.length > 0) {
                const byId = new Map(targets.map(t => [t.id, t]));
                const cachedTargets = cache.targetIds.map(id => byId.get(id)).filter(t => t);
                if (cachedTargets.length > 0) selected = cachedTargets;
            }

            if (!selected) {
                const sorted = [...targets].sort((a, b) => {
                    const aRatio = a.hitsMax > 0 ? (a.hits / a.hitsMax) : 1;
                    const bRatio = b.hitsMax > 0 ? (b.hits / b.hitsMax) : 1;
                    return aRatio - bRatio;
                });

                selected = sorted.slice(0, Math.min(MAX_REMOTE_TARGETS, sorted.length));
                cache.targetIds = selected.map(t => t.id);
                cache.lastScan = now;
            }
            const sourceIds = Array.isArray(entry.sourcesInfo) ? entry.sourcesInfo.map(s => s.id) : [];
            const containerIds = Array.isArray(entry.sourcesInfo)
                ? entry.sourcesInfo.map(s => s.containerId).filter(id => id)
                : [];

            debug('mission.remote.repair', `[RemoteRepair] ${room.name} -> ${name} targets=${selected.length}/${targets.length} ` +
                `workPerCreep=${workPerCreep}`);

            selected.forEach(target => {
                const pos = target.pos || { x: target.x, y: target.y, roomName: target.roomName };
                if (!pos || pos.x === undefined || pos.y === undefined || !pos.roomName) return;
                const targetPos = { x: pos.x, y: pos.y, roomName: pos.roomName };
                missions.push({
                    name: `remote:repair:${target.id}`,
                    type: 'remote_repair',
                    archetype: 'remote_worker',
                    targetId: target.id,
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
