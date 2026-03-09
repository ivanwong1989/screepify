const heap = require('utils_heap');

const STORE_NAME = 'overseerOpportunisticRepair';
const DEFAULT_SCAN_INTERVAL = 7;
const MIN_DAMAGE_RATIO = 0.95;
const MAX_TARGETS = 120;
const REPAIR_MIN_RATIO = 0.9;
const CRITICAL_GENERAL_RATIO = 0.8;
const CRITICAL_DECAYABLE_RATIO = 0.7;
const CRITICAL_WALL_HITS = 5000;
const FORTIFY_SETTINGS = {
    0: { start: 0, target: 0 },
    1: { start: 0, target: 0 },
    2: { start: 10000, target: 20000 },
    3: { start: 20000, target: 150000 },
    4: { start: 150000, target: 300000 },
    5: { start: 300000, target: 500000 },
    6: { start: 500000, target: 1300000 },
    7: { start: 2800000, target: 3500000 },
    8: { start: 3500000, target: 5000000 }
};

function getFortifyPolicy(room) {
    // Read policy from room memory when available (mission layer writes this),
    // otherwise fall back to RCL defaults so scanner can still run safely.
    const rcl = room && room.controller ? room.controller.level : 0;
    const defaults = FORTIFY_SETTINGS[rcl] || FORTIFY_SETTINGS[0];
    const memoryPolicy = room && room.memory && room.memory.overseer && room.memory.overseer.fortifyPolicy;

    const start = memoryPolicy && Number.isFinite(memoryPolicy.start) ? memoryPolicy.start : defaults.start;
    const target = memoryPolicy && Number.isFinite(memoryPolicy.target) ? memoryPolicy.target : defaults.target;
    return { start, target, rcl };
}

function getDesiredHits(room, st) {
    if (!st || !st.hitsMax) return 0;

    if (st.structureType === STRUCTURE_WALL || st.structureType === STRUCTURE_RAMPART) {
        // Walls/ramparts are evaluated against fortify target, not hitsMax.
        const policy = getFortifyPolicy(room);
        const target = policy.target;
        if (target <= 0) return 0;
        return Math.min(target, st.hitsMax);
    }

    return st.hitsMax;
}

function shouldTrack(room, st) {
    // Opportunistic micro-repair list used by creeps near damaged structures.
    // Keep this stricter (95%) to avoid noisy low-value targets.
    const desired = getDesiredHits(room, st);
    if (desired <= 0) return false;
    if (st.hits >= desired) return false;
    return st.hits < (desired * MIN_DAMAGE_RATIO);
}

function getStoreRoom(roomName) {
    const store = heap.getStore(STORE_NAME, { ttl: null });
    if (!store.rooms) store.rooms = Object.create(null);
    if (!store.rooms[roomName]) {
        // Heap payload contract:
        // - targets: opportunistic local repair data (id/pos/desiredHits/ratio)
        // - repairIds/fortifyIds/targetIds: mission-facing classified IDs
        // - critical: quick flag to increase scan urgency
        store.rooms[roomName] = {
            lastScan: 0,
            scanInterval: DEFAULT_SCAN_INTERVAL,
            targets: [],
            repairIds: [],
            fortifyIds: [],
            targetIds: [],
            critical: false
        };
    }
    return store.rooms[roomName];
}

function isCritical(st) {
    if (!st || !st.hitsMax) return false;
    if (st.structureType === STRUCTURE_WALL || st.structureType === STRUCTURE_RAMPART) {
        return st.hits < CRITICAL_WALL_HITS;
    }
    if (st.structureType === STRUCTURE_ROAD || st.structureType === STRUCTURE_CONTAINER) {
        return st.hits < (st.hitsMax * CRITICAL_DECAYABLE_RATIO);
    }
    return st.hits < (st.hitsMax * CRITICAL_GENERAL_RATIO);
}

function needsRepair(st) {
    if (!st || !st.hitsMax) return false;
    if (st.structureType === STRUCTURE_WALL || st.structureType === STRUCTURE_RAMPART) return false;
    return st.hits < (st.hitsMax * REPAIR_MIN_RATIO);
}

module.exports = {
    scan: function(room, intel, opts) {
        if (!room) return null;
        const roomStore = getStoreRoom(room.name);

        const scanInterval = (opts && Number.isFinite(opts.scanInterval))
            ? Math.max(1, Math.floor(opts.scanInterval))
            : DEFAULT_SCAN_INTERVAL;
        roomStore.scanInterval = scanInterval;

        // One scan pass per interval (or forced) populates all downstream consumers.
        const forceScan = !!(opts && opts.forceScan);
        const shouldScan = forceScan || !roomStore.lastScan || (Game.time - roomStore.lastScan) >= scanInterval;
        if (!shouldScan) return roomStore;

        // Single pass over room structures:
        // 1) build opportunistic list for role.universal
        // 2) classify repair/fortify IDs for mission.repair
        const grouped = intel && intel.structures ? Object.values(intel.structures) : [];
        const allStructures = [].concat(...grouped);
        const targets = [];
        const repairEntries = [];
        const fortifyEntries = [];
        const previousFortifyIds = new Set(roomStore.fortifyIds || []);
        const policy = getFortifyPolicy(room);
        const fortifyStart = policy.start;
        const fortifyTarget = policy.target;
        let criticalFound = false;

        for (let i = 0; i < allStructures.length; i++) {
            const st = allStructures[i];
            if (!st || !st.id || !st.pos || !st.hitsMax) continue;
            const desired = getDesiredHits(room, st);

            if (shouldTrack(room, st)) {
                const ratio = desired > 0 ? (st.hits / desired) : 1;
                targets.push({
                    id: st.id,
                    roomName: st.pos.roomName,
                    x: st.pos.x,
                    y: st.pos.y,
                    desiredHits: desired,
                    ratio: ratio
                });
            }

            const wallOrRampart = st.structureType === STRUCTURE_WALL || st.structureType === STRUCTURE_RAMPART;
            if (wallOrRampart) {
                if (fortifyTarget <= 0) continue;
                // Hysteresis: start at lower threshold, continue until target.
                const activeFort = st.hits < fortifyStart || (previousFortifyIds.has(st.id) && st.hits < fortifyTarget);
                if (!activeFort) continue;
                const ratio = fortifyTarget > 0 ? (st.hits / fortifyTarget) : 1;
                if (isCritical(st)) {
                    criticalFound = true;
                    repairEntries.push({ id: st.id, ratio, group: 2 });
                } else {
                    fortifyEntries.push({ id: st.id, ratio });
                }
                continue;
            }

            if (needsRepair(st)) {
                const ratio = st.hitsMax > 0 ? (st.hits / st.hitsMax) : 1;
                const group = (st.structureType === STRUCTURE_ROAD || st.structureType === STRUCTURE_CONTAINER) ? 0 : 1;
                if (isCritical(st)) criticalFound = true;
                repairEntries.push({ id: st.id, ratio, group });
            }
        }

        targets.sort((a, b) => a.ratio - b.ratio);
        roomStore.targets = targets.slice(0, MAX_TARGETS);
        repairEntries.sort((a, b) => {
            const groupDiff = a.group - b.group;
            if (groupDiff !== 0) return groupDiff;
            return a.ratio - b.ratio;
        });
        fortifyEntries.sort((a, b) => a.ratio - b.ratio);

        roomStore.repairIds = repairEntries.map(e => e.id);
        roomStore.fortifyIds = fortifyEntries.map(e => e.id);
        roomStore.targetIds = roomStore.repairIds.concat(roomStore.fortifyIds);
        // Critical means at least one urgent repair-class target exists.
        roomStore.critical = criticalFound;
        roomStore.lastScan = Game.time;
        return roomStore;
    },

    getRoomScan: function(roomName) {
        if (!roomName) return null;
        return getStoreRoom(roomName);
    }
};
