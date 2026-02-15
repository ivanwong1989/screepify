const managerSpawner = require('managers_spawner_manager.room.economy.spawner');

const getBuildQueue = function(room, sites) {
    if (!room.memory.overseer) room.memory.overseer = {};
    const mem = room.memory.overseer;
    if (!Array.isArray(mem.buildQueue)) mem.buildQueue = [];
    if (!mem.buildQueueMeta) mem.buildQueueMeta = {};

    const siteIds = Array.isArray(sites) ? sites.map(s => s.id) : [];
    const siteSet = new Set(siteIds);

    // Drop stale queue entries and meta for completed/removed sites.
    let queue = mem.buildQueue.filter(id => siteSet.has(id));
    const meta = mem.buildQueueMeta;
    for (const id in meta) {
        if (!siteSet.has(id)) delete meta[id];
    }

    // Append newly seen sites in their current order.
    const existing = new Set(queue);
    for (const id of siteIds) {
        if (!existing.has(id)) {
            queue.push(id);
            meta[id] = Game.time;
        }
    }

    // Ensure deterministic FIFO order based on first seen tick.
    queue.sort((a, b) => {
        const aTick = meta[a] || 0;
        const bTick = meta[b] || 0;
        if (aTick !== bTick) return aTick - bTick;
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
    });

    mem.buildQueue = queue;
    return queue;
};

module.exports = {
    generate: function(room, intel, context, missions) {
        const { state, budget } = context;
        if (intel.constructionSites.length === 0 || state === 'EMERGENCY') return;

        const buildStats = managerSpawner.checkBody('worker', budget);
        const buildTarget = 5;
        const workPerCreep = buildStats.work || 1;
        const desiredCount = Math.max(1, Math.ceil(buildTarget / workPerCreep));

        const queue = getBuildQueue(room, intel.constructionSites);
        if (!queue || queue.length === 0) return;

        const targetId = queue[0];
        const byId = new Map(intel.constructionSites.map(s => [s.id, s]));
        const site = byId.get(targetId);
        if (!site) return;

        debug('mission.build', `[Build] ${room.name} target=1/${intel.constructionSites.length} ` +
            `queue=${queue.length} workPerCreep=${workPerCreep} desired=${desiredCount}`);

        missions.push({
            name: `build:${site.id}`,
            type: 'build',
            archetype: 'worker',
            targetId: site.id,
            data: { sourceIds: intel.allEnergySources.map(s => s.id) },
            requirements: {
                archetype: 'worker',
                count: desiredCount,
                spawnFromFleet: true
            },
            priority: 60
        });
    }
};
