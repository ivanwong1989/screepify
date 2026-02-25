// safemodeManager.js
// Simple conservative SafeMode trigger using roomCache to save CPU.

const DEFAULTS = Object.freeze({
    // Rampart hits threshold for "breach imminent"
    weakRampartHits: 5000,

    // Hostile must be this close to spawn to count as "breach attempt"
    hostileNearSpawnRange: 1,

    // Avoid repeated activate calls / log spam
    minRetryInterval: 5
});

function isOwnedRoom(room) {
    return room && room.controller && room.controller.my;
}

function canSafeMode(room) {
    const c = room.controller;
    return c && c.my && !c.safeMode && c.safeModeAvailable > 0;
}

function anyCoreDamaged(core) {
    for (const s of core) {
        if (s && s.hits != null && s.hitsMax != null && s.hits < s.hitsMax) return true;
    }
    return false;
}

function hostileNearAnySpawn(spawns, hostiles, range) {
    if (!spawns.length || !hostiles.length) return false;

    // Cheap range checks (no PathFinder)
    for (const sp of spawns) {
        for (const h of hostiles) {
            if (sp.pos.getRangeTo(h.pos) <= range) return true;
        }
    }
    return false;
}

function weakRampartProtectingCoreUnderPressure(room, cache, core, hostiles, weakHits) {
    if (!core.length || !hostiles.length) return false;

    const ramps = (cache && cache.myStructuresByType && cache.myStructuresByType[STRUCTURE_RAMPART]) || [];
    if (!ramps.length) return false;

    // For each core structure, find ramparts adjacent (range 1).
    // If any such rampart is weak AND a hostile is adjacent to that rampart => trigger.
    for (const s of core) {
        if (!s) continue;

        // Scan ramparts for adjacency to core structure (range 1)
        for (const r of ramps) {
            if (!r) continue;
            if (r.hits > weakHits) continue;
            if (r.pos.getRangeTo(s.pos) > 1) continue;

            // Any hostile adjacent to that weak rampart?
            for (const h of hostiles) {
                if (r.pos.getRangeTo(h.pos) <= 1) return true;
            }
        }
    }

    return false;
}

function buildCore(room, cache) {
    const spawns = (cache && cache.myStructuresByType && cache.myStructuresByType[STRUCTURE_SPAWN]) || [];
    const core = [];
    if (spawns.length) core.push(...spawns);
    if (room.storage) core.push(room.storage);
    if (room.terminal) core.push(room.terminal);
    return { core, spawns };
}

module.exports = {
    run(room, cache, opts = {}) {
        if (!isOwnedRoom(room)) return;
        if (!canSafeMode(room)) return;

        // Pull hostiles from cache (cheap)
        const hostiles = (cache && cache.hostiles) || [];
        if (!hostiles.length) return;

        // Minimal retry throttling
        room.memory._sm = room.memory._sm || {};
        const lastTry = room.memory._sm.lastTry || 0;
        if (lastTry && (Game.time - lastTry) < (opts.minRetryInterval || DEFAULTS.minRetryInterval)) return;

        const weakRampartHits = Number.isFinite(opts.weakRampartHits) ? opts.weakRampartHits : DEFAULTS.weakRampartHits;
        const hostileNearSpawnRange = Number.isFinite(opts.hostileNearSpawnRange) ? opts.hostileNearSpawnRange : DEFAULTS.hostileNearSpawnRange;

        const { core, spawns } = buildCore(room, cache);

        // Conditions (conservative)
        const coreDamaged = anyCoreDamaged(core);
        const nearSpawn = hostileNearAnySpawn(spawns, hostiles, hostileNearSpawnRange);
        const weakRampUnderPressure = weakRampartProtectingCoreUnderPressure(room, cache, core, hostiles, weakRampartHits);

        if (!(coreDamaged || nearSpawn || weakRampUnderPressure)) return;

        room.memory._sm.lastTry = Game.time;

        const res = room.controller.activateSafeMode();
        if (res === OK) {
            room.memory._sm.lastActivated = Game.time;
            console.log(`[SafeMode] Activated in ${room.name} at ${Game.time} (coreDamaged=${+coreDamaged} nearSpawn=${+nearSpawn} weakRamp=${+weakRampUnderPressure})`);
        } else {
            console.log(`[SafeMode] Activate FAILED in ${room.name}: ${res} at ${Game.time}`);
        }
    }
};