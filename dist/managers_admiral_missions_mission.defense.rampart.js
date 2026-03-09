/**
 * Rampart Guard Defense Mission
 *
 * Spawns a cheap melee "biter" ONLY when tower analysis says
 * that towers alone are insufficient but towers + 1 defender
 * would flip the result at the chosen intercept.
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

        const intel = room.memory && room.memory.intel;
        const assist = intel && intel.defenseAssist;

        // V1: defense spawning is tower-assist driven, not hostile-presence driven.
        if (!assist || assist.evaluated !== true) return;
        if (assist.needsMeleeAssist !== true) return;
        if (assist.interceptType !== 'rampart' && assist.interceptType !== 'ring') return;

        const cache = global.getRoomCache(room);
        const { budget, getMissionCensus } = context || {};

        const body = getBody(budget);
        const cost = getBodyCost(body);
        const spawnAllowed = !cost || (Number.isFinite(budget) && budget >= cost);

        // V1 contract: only spawn exactly 1 defender when +1 flips the outcome.
        const desired = 1;

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

            // spawn planner can dedupe by slot key rather than summing desired.
            spawnSlots: makeSpawnSlots(room.name, desired),

            requirements: {
                archetype: 'defender',
                minCount: desired,
                maxCount: desired,
                body,
                bodyMode: 'fixed',
                spawn: spawnAllowed
            },
            data: {
                ownerRoom: room.name,
                defendRoom: room.name,
                targetRoom: room.name,

                anchorPos: toPos(anchor && anchor.pos),

                rules: {
                    maxDefenders: 1
                },

                // For tactics convenience / intercept-aware behavior
                hostileIds,
                assistTargetId: assist.targetId || null,
                interceptType: assist.interceptType || null,
                interceptPos: assist.interceptPos || null
            },
            census
        });
    }
};
