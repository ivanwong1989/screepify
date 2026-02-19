'use strict';

module.exports = function resolveBuildTarget(room, intel) {
    if (!room || !intel || !Array.isArray(intel.constructionSites)) return null;

    const sites = intel.constructionSites;
    if (sites.length === 0) return null;

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
    if (!queue || queue.length === 0) return null;

    const targetId = queue[0];
    const byId = new Map(sites.map(s => [s.id, s]));
    const site = byId.get(targetId);
    if (!site) return null;

    return { targetId: site.id, queue };
};
