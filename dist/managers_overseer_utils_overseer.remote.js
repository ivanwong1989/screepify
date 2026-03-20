// overseer.remote.js
//
// Scout-backed remote context.
// Reads from: room.memory.overseer.scout (new format from overseer.scout.js)
// Removes: old remote memory tree + "must be reserved by me" gating.
// Enables by default for non-hostile rooms, with RCL3+ room-count gating.
const HOSTILE_GATE_TICKS = 100; // ~6h at ~3s/tick
const DEFENSE_PRESENCE_ROLES = Object.freeze({
    defender: true,
    brawler: true,
    assault: true,
    drainer: true,
    dismantler: true
});

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

function hasOwnedDefensePresence(roomName) {
    if (!roomName) return false;
    const observedRoom = Game.rooms[roomName];
    if (!observedRoom) return false;

    const myCreeps = observedRoom.find(FIND_MY_CREEPS);
    for (let i = 0; i < myCreeps.length; i++) {
        const creep = myCreeps[i];
        if (!creep || creep.spawning) continue;

        const role = creep.memory && creep.memory.role;
        if (role && DEFENSE_PRESENCE_ROLES[role]) return true;

        if (
            creep.getActiveBodyparts(ATTACK) > 0 ||
            creep.getActiveBodyparts(RANGED_ATTACK) > 0 ||
            creep.getActiveBodyparts(HEAL) > 0
        ) {
            return true;
        }
    }

    return false;
}

function isRoomEligibleFromScoutEntry(entry, maxScoutAge, roomName) {
    if (!entry) return false;
    const defensePresent = hasOwnedDefensePresence(roomName);

    // Freshness: prefer lastSeen (always updated by scout), fallback to lastScout.
    const lastSeen = Number.isFinite(entry.lastSeen) ? entry.lastSeen : 0;
    const lastScout = Number.isFinite(entry.lastScout) ? entry.lastScout : 0;
    const ts = lastSeen || lastScout || 0;

    if (maxScoutAge && ts > 0 && (Game.time - ts) > maxScoutAge) return false;

    // If threat was seen recently, keep this remote gated for a cooldown period.
    // Exception: if we already have a defense force in the room, don't apply hostile cooldown gate.
    const threat = entry.threat || {};
    const lastThreatSeen = Number.isFinite(threat.lastThreatSeen)
        ? threat.lastThreatSeen
        : Math.max(
            Number.isFinite(threat.lastHostileSeen) ? threat.lastHostileSeen : 0,
            Number.isFinite(threat.lastAttackerSeen) ? threat.lastAttackerSeen : 0
        );
    if (!defensePresent && lastThreatSeen > 0 && (Game.time - lastThreatSeen) < HOSTILE_GATE_TICKS) return false;

    // Non-hostile gating:
    // scout may set status='hostile' when empty+hostiles/structures were seen.
    const status = entry.status;
    if (!status) return false;

    // Reject anything that isn't "neutral enough" for v1.
    // Allowed: 'empty' (and optionally 'reserved' if you want)
    if (status === 'owned' || status === 'occupied' || status === 'ally') return false;
    if (!defensePresent && status === 'hostile') return false;

    // Hard reject if explicit hostiles/hostile structures were seen.
    // Exception: allow hostile creeps while we have our own defense force present in-room.
    if (!defensePresent && (entry.hostiles || 0) > 0) return false;
    if (!defensePresent && (entry.hostileAttackers || 0) > 0) return false;
    if ((entry.hostileStructures || 0) > 0) return false;

    // Must have sources info
    const sourceCount = Array.isArray(entry.sourcesInfo) ? entry.sourcesInfo.length : (entry.sources || 0);
    if (sourceCount <= 0) return false;

    return true;
}

function getAllies() {
    if (!Array.isArray(Memory.allies)) return [];
    return Memory.allies.map(a => ('' + a).toLowerCase());
}

function isAllyName(name, allies) {
    if (!name) return false;
    return Array.isArray(allies) && allies.includes(('' + name).toLowerCase());
}

function getRuntimeThreatStampCache() {
    const cache = global._remoteRuntimeThreatStamp;
    if (cache && cache.time === Game.time) return cache;
    const next = { time: Game.time, keys: Object.create(null) };
    global._remoteRuntimeThreatStamp = next;
    return next;
}

function recordRuntimeThreatIntel(sponsorRoomName, observedRoom) {
    if (!sponsorRoomName || !observedRoom || observedRoom.name === sponsorRoomName) return false;

    const sponsorRoom = Game.rooms[sponsorRoomName];
    const sponsorMemory = sponsorRoom
        ? sponsorRoom.memory
        : (Memory.rooms[sponsorRoomName] = Memory.rooms[sponsorRoomName] || {});

    if (!sponsorMemory.overseer) sponsorMemory.overseer = {};
    if (!sponsorMemory.overseer.scout) sponsorMemory.overseer.scout = {};
    const scoutMem = sponsorMemory.overseer.scout;
    if (!scoutMem.rooms) scoutMem.rooms = {};

    const stampKey = `${sponsorRoomName}:${observedRoom.name}`;
    const stampCache = getRuntimeThreatStampCache();
    if (stampCache.keys[stampKey]) return false;

    const allies = getAllies();
    const hostileCreeps = observedRoom.find(FIND_HOSTILE_CREEPS).filter(c =>
        !isAllyName(c && c.owner && c.owner.username, allies)
    );
    const hostileAttackers = hostileCreeps.filter(c =>
        (c.getActiveBodyparts(ATTACK) || c.getActiveBodyparts(RANGED_ATTACK))
    );
    const hostileStructures = observedRoom.find(FIND_HOSTILE_STRUCTURES).filter(s =>
        !isAllyName(s && s.owner && s.owner.username, allies)
    );

    if (hostileCreeps.length <= 0 && hostileStructures.length <= 0) return false;

    const now = Game.time;
    const entry = scoutMem.rooms[observedRoom.name] || (scoutMem.rooms[observedRoom.name] = {
        lastScout: 0,
        lastSeen: 0
    });

    entry.lastSeen = now;
    entry.status = 'hostile';
    entry.hostiles = hostileCreeps.length;
    entry.hostileAttackers = hostileAttackers.length;
    entry.hostileStructures = hostileStructures.length;

    if (!entry.threat) {
        entry.threat = { level: 0, lastHostileSeen: 0, lastAttackerSeen: 0, lastThreatSeen: 0 };
    }
    if (entry.hostiles > 0) entry.threat.lastHostileSeen = now;
    if (entry.hostileAttackers > 0) entry.threat.lastAttackerSeen = now;
    entry.threat.lastThreatSeen = now;
    if (entry.hostileAttackers > 0) entry.threat.level = 2;
    else entry.threat.level = 1;
    if (entry.hostileAttackers > 0 && entry.hostileStructures > 0) entry.threat.level = 3;

    stampCache.keys[stampKey] = true;
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

    // RCL-gated remote room cap:
    // RCL < 3: disabled
    // RCL 3: 1 room
    // RCL 4: 2 rooms
    // RCL 5: 3 rooms
    // RCL >= 6: 4 rooms (hard cap)
    const rcl = room.controller ? room.controller.level : 0;
    //const maxRemoteRooms = (rcl < 3) ? 0 : Math.min(4, rcl - 2);
    const maxRemoteRooms = 1;
    const rclOk = maxRemoteRooms > 0;

    const skipRooms = new Set(scoutMem.skipRooms || []);
    const roomsMem = scoutMem.rooms || {};
    const baseEnabled = !!(globalEnabled && roomEnabled && stateOk && rclOk);
    const candidates = [];

    for (const name of Object.keys(roomsMem)) {
        if (skipRooms.has(name)) continue;

        const entry = roomsMem[name];
        const eligible = isRoomEligibleFromScoutEntry(entry, maxScoutAge, name);
        candidates.push({
            name,
            entry,
            room: Game.rooms[name] || null,
            eligible
        });
    }

    let enabledNames = null;
    if (baseEnabled) {
        const rankedEligible = candidates.filter(c => c.eligible);
        rankedEligible.sort((a, b) => {
            const distA = Game.map.getRoomLinearDistance(room.name, a.name);
            const distB = Game.map.getRoomLinearDistance(room.name, b.name);
            if (distA !== distB) return distA - distB;
            return a.name.localeCompare(b.name);
        });

        // Keep previously enabled rooms sticky when still eligible to avoid flip-flopping
        // between equal-distance candidates at the same RCL cap.
        const prevEntries = room._remoteContext && Array.isArray(room._remoteContext.entries)
            ? room._remoteContext.entries
            : [];
        const prevEnabled = new Set(
            prevEntries
                .filter(e => e && e.enabled && e.name)
                .map(e => e.name)
        );

        const chosen = [];
        for (let i = 0; i < rankedEligible.length && chosen.length < maxRemoteRooms; i++) {
            const c = rankedEligible[i];
            if (!prevEnabled.has(c.name)) continue;
            chosen.push(c.name);
        }
        for (let i = 0; i < rankedEligible.length && chosen.length < maxRemoteRooms; i++) {
            const c = rankedEligible[i];
            if (chosen.indexOf(c.name) !== -1) continue;
            chosen.push(c.name);
        }
        enabledNames = new Set(chosen);
    }

    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const enabled = !!(baseEnabled && candidate.eligible && enabledNames && enabledNames.has(candidate.name));
        entries.push({
            name: candidate.name,
            entry: candidate.entry,
            room: candidate.room, // may be null if not visible
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
    getRemoteEconomicContext,
    recordRuntimeThreatIntel
};
