// overseer.remote.js
//
// Scout-backed remote context.
// Reads from: room.memory.overseer.scout (new format from overseer.scout.js)
// Removes: old remote memory tree + "must be reserved by me" gating.
// Enables by default for non-hostile rooms, gated by RCL2.

function getSponsorScoutMemory(room) {
    if (!room) return null;
    if (!room.memory) room.memory = {};
    if (!room.memory.overseer) room.memory.overseer = {};
    if (!room.memory.overseer.scout) room.memory.overseer.scout = {};

    const scoutMem = room.memory.overseer.scout;

    if (scoutMem.enabled === undefined) scoutMem.enabled = true;
    if (!Array.isArray(scoutMem.skipRooms)) scoutMem.skipRooms = [];
    if (!scoutMem.rooms) scoutMem.rooms = {};

    return scoutMem;
}

function isRoomEligibleFromScoutEntry(entry, maxScoutAge) {
    if (!entry) return false;

    // Freshness: prefer lastSeen (always updated by scout), fallback to lastScout.
    const lastSeen = Number.isFinite(entry.lastSeen) ? entry.lastSeen : 0;
    const lastScout = Number.isFinite(entry.lastScout) ? entry.lastScout : 0;
    const ts = lastSeen || lastScout || 0;

    if (maxScoutAge && ts > 0 && (Game.time - ts) > maxScoutAge) return false;

    // Non-hostile gating:
    // scout may set status='hostile' when empty+hostiles/structures were seen.
    const status = entry.status;
    if (!status) return false;

    // Reject anything that isn't "neutral enough" for v1.
    // Allowed: 'empty' (and optionally 'reserved' if you want)
    if (status === 'owned' || status === 'occupied' || status === 'ally' || status === 'hostile') return false;

    // Hard reject if explicit hostiles/hostile structures were seen.
    if ((entry.hostiles || 0) > 0) return false;
    if ((entry.hostileAttackers || 0) > 0) return false;
    if ((entry.hostileStructures || 0) > 0) return false;

    // Must have sources info
    const sourceCount = Array.isArray(entry.sourcesInfo) ? entry.sourcesInfo.length : (entry.sources || 0);
    if (sourceCount <= 0) return false;

    return true;
}

function getRemoteContext(room, options = {}) {
    // Per-tick cache (same pattern as old file)
    if (room && room._remoteContext && room._remoteContext.time === Game.time) {
        return room._remoteContext.entries || [];
    }

    const entries = [];
    if (!room) return entries;

    const scoutMem = getSponsorScoutMemory(room);
    if (!scoutMem) return entries;

    const opState = options.opState || null;
    const maxScoutAge = Number.isFinite(options.maxScoutAge) ? options.maxScoutAge : 4000;

    // Global + per-room enable toggles
    const globalEnabled = Memory.remoteMissionsEnabled !== false;
    const roomEnabled = scoutMem.enabled !== false;
    const stateOk = opState !== 'EMERGENCY';

    // RCL2 gate (your rule: start remote drop mining as soon as RCL2)
    const rcl = room.controller ? room.controller.level : 0;
    const rclOk = rcl >= 2;

    const skipRooms = new Set(scoutMem.skipRooms || []);
    const roomsMem = scoutMem.rooms || {};

    for (const name of Object.keys(roomsMem)) {
        if (skipRooms.has(name)) continue;

        const entry = roomsMem[name];
        const eligible = isRoomEligibleFromScoutEntry(entry, maxScoutAge);

        const enabled = !!(globalEnabled && roomEnabled && stateOk && rclOk && eligible);
        entries.push({
            name,
            entry,
            room: Game.rooms[name] || null, // may be null if not visible
            enabled
        });
    }

    room._remoteContext = { time: Game.time, entries };
    return entries;
}

function getRemoteEconomicContext(room, options = {}) {
    return getRemoteContext(room, options);
}

module.exports = {
    getRemoteContext,
    getRemoteEconomicContext
};