/**
 * Rampart Guard Defense Mission
 *
 * Spawns 1–2 cheap melee "biters" that:
 * - NEVER chase outside the room
 * - Prefer standing on ramparts
 * - Attack enemies adjacent to ramparts
 *
 * Hook: called by admiral.missions.js like the other mission generators.
 */

function getBody(budget) {
    // ultra-cheap fallback (junior room)
    if (!Number.isFinite(budget) || budget < 260) return [ATTACK, MOVE];                 // 130
    if (budget < 350) return [ATTACK, ATTACK, MOVE, MOVE];                               // 260
    return [ATTACK, ATTACK, ATTACK, MOVE, MOVE];                                         // 350
}

function getBodyCost(body) {
    return (body || []).reduce((sum, p) => sum + (BODYPART_COST[p] || 0), 0);
}

function toPos(pos) {
    return pos ? { x: pos.x, y: pos.y, roomName: pos.roomName } : null;
}

// Stable spawn slot keys (same idea as mission.harvest.js)
function makeSpawnSlots(roomName, count) {
    const slots = [];
    const n = Math.max(0, count | 0);
    for (let i = 0; i < n; i++) {
        slots.push(`defendRampart:${roomName}:${i}`);
    }
    return slots;
}

module.exports = {
    generate(room, hostiles, context, missions) {
        if (!room || !room.controller || !room.controller.my) return;
        if (!Array.isArray(hostiles) || hostiles.length === 0) return;

        const cache = global.getRoomCache(room);
        const { budget, getMissionCensus } = context || {};

        const body = getBody(budget);
        const cost = getBodyCost(body);
        const spawnAllowed = !cost || (Number.isFinite(budget) && budget >= cost);

        // 1–2 defenders is usually enough; scale lightly by hostile count
        const desired = Math.min(2, Math.max(1, hostiles.length >= 2 ? 2 : 1));

        const missionName = `defendRampart_${room.name}`;
        const census = typeof getMissionCensus === 'function'
            ? getMissionCensus(missionName)
            : { count: 0, workParts: 0, carryParts: 0 };

        const spawnList = cache && cache.myStructuresByType && cache.myStructuresByType[STRUCTURE_SPAWN];
        const anchor = (spawnList && spawnList[0]) || room.controller;

        // Keep hostileIds bounded (avoid bloating memory on huge swarms)
        const hostileIds = hostiles.length <= 12
            ? hostiles.map(h => h.id)
            : hostiles.slice(0, 12).map(h => h.id);

        missions.push({
            name: missionName,
            type: 'defend',
            archetype: 'defender',
            priority: 97,

            // IMPORTANT: spawnSlots makes spawning much more robust against duplicate missions,
            // because the spawn planner can dedupe by slot key rather than summing desired.
            spawnSlots: makeSpawnSlots(room.name, desired),

            requirements: {
                archetype: 'defender',
                count: desired,
                body,
                bodyMode: 'fixed',
                spawn: spawnAllowed
            },
            data: {
                ownerRoom: room.name,
                defendRoom: room.name,

                // IMPORTANT: contracts code often expects targetRoom for defend keying
                // (prevents weird defend:<room>:undefined keys).
                targetRoom: room.name,

                anchorPos: toPos(anchor && anchor.pos),

                // Optional: gives you knobs later without rewriting
                rules: {
                    maxDefenders: 2
                },

                // For tactics convenience
                hostileIds
            },
            census
        });
    }
};