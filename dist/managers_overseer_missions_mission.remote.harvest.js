// mission.remote.haul.js (patched: heap-backed lane cache + reset-safe + rate-limited rebuild)
const managerSpawner = require('managers_spawner_manager.room.economy.spawner');
const remoteUtils = require('managers_overseer_utils_overseer.remote');

const toRoomPosition = (pos) => {
    if (!pos || !pos.roomName) return null;
    const x = Number(pos.x);
    const y = Number(pos.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return new RoomPosition(x, y, pos.roomName);
};

// Heap lane TTL (ticks). When expired, we may rebuild lazily.
const LANE_TTL = 10000;

// Memory meta TTL (ticks). Keep small, just for sizing + stability across heap reset.
const META_TTL = 20000;

// Rate-limit heavy path builds per home-room per tick to avoid spikes on heap reset.
const MAX_PATH_REBUILDS_PER_TICK_PER_HOME = 2;

// ------------------------------------------------------------
// Global heap cache helpers (reset-safe).
// ------------------------------------------------------------
const getGlobalRoot = () => {
    if (!global.__remoteHaulLaneCache) {
        global.__remoteHaulLaneCache = {
            rooms: Object.create(null), // homeRoom -> { sig, lanes, meta, budgetTick, budgetUsed }
        };
    }
    return global.__remoteHaulLaneCache;
};

const getRoomHeapCache = (homeRoom) => {
    const root = getGlobalRoot();
    let r = root.rooms[homeRoom];
    if (!r) {
        r = root.rooms[homeRoom] = {
            sig: null,
            lanes: Object.create(null), // laneKey -> { p, len, t, sig, from, to }
            meta: Object.create(null),  // pickupId -> { pathLen, created }
            budgetTick: -1,
            budgetUsed: 0,
        };
    }

    // Reset per-tick rebuild budget
    if (r.budgetTick !== Game.time) {
        r.budgetTick = Game.time;
        r.budgetUsed = 0;
    }
    return r;
};

const isFresh = (t, ttl) => (t != null) && (Game.time - t <= ttl);

const packPathPoints = (fromPos, path) => {
    // Multi-room safe compact points: [{r,x,y},...]
    // Include fromPos as first point so moveByPath can start immediately.
    const pts = [];
    if (fromPos && fromPos.roomName) {
        pts.push({ r: fromPos.roomName, x: fromPos.x, y: fromPos.y });
    }
    if (Array.isArray(path)) {
        for (let i = 0; i < path.length; i++) {
            const p = path[i];
            if (!p) continue;
            pts.push({ r: p.roomName, x: p.x, y: p.y });
        }
    }
    return pts;
};

const computePathData = (fromPos, toPos, memo) => {
    if (!fromPos || !toPos) return { len: 1, points: null, incomplete: true };

    const key = `${fromPos.roomName}:${fromPos.x},${fromPos.y}:${toPos.roomName}:${toPos.x},${toPos.y}`;
    if (memo && memo.has(key)) return memo.get(key);

    const result = PathFinder.search(fromPos, { pos: toPos, range: 1 }, {
        maxOps: 4000,
        plainCost: 2,
        swampCost: 10,
    });

    const len = result.incomplete
        ? fromPos.getRangeTo(toPos)
        : (result.path ? result.path.length : 0);

    const points = (!result.incomplete && result.path && result.path.length)
        ? packPathPoints(fromPos, result.path)
        : null;

    const data = { len: len || 1, points, incomplete: !!result.incomplete };
    if (memo) memo.set(key, data);
    return data;
};

// ------------------------------------------------------------
// Small Memory meta (optional): only keeps signature + per-pickup pathLen.
// No paths, no point arrays.
// ------------------------------------------------------------
const getRoomMemoryMeta = (room) => {
    if (!room.memory.overseer) room.memory.overseer = {};
    if (!room.memory.overseer.remoteHaulMeta) {
        room.memory.overseer.remoteHaulMeta = { sig: null, pickups: {} };
    }
    return room.memory.overseer.remoteHaulMeta;
};

const pruneMeta = (meta) => {
    if (!meta || !meta.pickups) return;
    for (const pickupId in meta.pickups) {
        const e = meta.pickups[pickupId];
        if (!e || !isFresh(e.t, META_TTL)) delete meta.pickups[pickupId];
    }
};

module.exports = {
    generate: function (room, intel, context, missions) {
        if (context.opState === 'EMERGENCY') return;

        const miningContainerIds = new Set(intel.sources.map(s => s.containerId).filter(id => id));
        const allContainers = intel.structures[STRUCTURE_CONTAINER] || [];
        const nonMiningContainers = allContainers.filter(c => !miningContainerIds.has(c.id));
        const dropoffTarget = room.storage || nonMiningContainers[0];

        if (!dropoffTarget) {
            debug('mission.remote.haul', `[RemoteHaul] ${room.name} skipped: no dropoff target`);
            return;
        }

        const entries = remoteUtils.getRemoteEconomicContext(room, {
            opState: context.opState,
            maxScoutAge: 4000,
        });

        const { budget, getMissionCensus } = context;
        const haulerStats = managerSpawner.checkBody('remote_hauler', budget);

        // ============================================================
        // SIZING: keep it simple (hardcode targetWork, derived energyPerTick)
        // ============================================================
        const TARGET_WORK = 5;
        const ENERGY_PER_TICK = 2 * TARGET_WORK;

        const TRANSFER_BUFFER_TICKS = 2;

        const DISTANCE_SOFT_CAP = 25;
        const DISTANCE_SCALE_PER_TILE = 0.002;

        const MAX_REMOTE_HAULER_CARRY_PARTS = 25;
        const carryParts = Math.min(haulerStats.carry || 1, MAX_REMOTE_HAULER_CARRY_PARTS);

        // ============================================================
        // Signature invalidation (dropoff changes).
        // ============================================================
        const targetSignature = `dropoff:${dropoffTarget.id}`;

        // Heap cache (per home room)
        const heap = getRoomHeapCache(room.name);
        if (heap.sig !== targetSignature) {
            heap.sig = targetSignature;
            heap.lanes = Object.create(null);
            heap.meta = Object.create(null);
            // leave budget counters; they reset per tick anyway
        }

        // Tiny Memory meta for stability across heap reset (optional)
        const memMeta = getRoomMemoryMeta(room);
        if (memMeta.sig !== targetSignature) {
            memMeta.sig = targetSignature;
            memMeta.pickups = {};
        }
        pruneMeta(memMeta);

        // Tick-local memoization (only within this generate pass)
        const pathMemo = new Map();

        // Helper: attempt to get lane from heap
        const getLane = (laneKey) => {
            const e = heap.lanes[laneKey];
            if (!e) return null;
            if (e.sig !== targetSignature) return null;
            if (!e.p || !e.p.length) return null;
            if (!isFresh(e.t, LANE_TTL)) return null;
            return e;
        };

        // Helper: write lane to heap
        const setLane = (laneKey, points, len, fromPos, toPos) => {
            heap.lanes[laneKey] = {
                p: points,
                len,
                t: Game.time,
                sig: targetSignature,
                from: `${fromPos.roomName}:${fromPos.x},${fromPos.y}`,
                to: `${toPos.roomName}:${toPos.x},${toPos.x},${toPos.y}`, // harmless extra field, for debugging only
            };
        };

        // Helper: get best-known pathLen without forcing path rebuild
        const getKnownPathLen = (pickupId) => {
            const hm = heap.meta[pickupId];
            if (hm && isFresh(hm.created, LANE_TTL) && hm.pathLen) return hm.pathLen;

            const mm = memMeta.pickups[pickupId];
            if (mm && isFresh(mm.t, META_TTL) && mm.pathLen) return mm.pathLen;

            return null;
        };

        // Helper: store pathLen in heap + Memory meta (tiny)
        const recordPathLen = (pickupId, pathLen) => {
            heap.meta[pickupId] = { pathLen, created: Game.time };
            memMeta.pickups[pickupId] = { pathLen, t: Game.time };
        };

        // Helper: rebuild lanes (rate-limited)
        const maybeRebuildLanes = (pickupId, dropoffPos, pickupPos, laneKeyToPickup, laneKeyToDropoff) => {
            // If both lanes exist and fresh: nothing to do
            const lf = getLane(laneKeyToPickup);
            const lr = getLane(laneKeyToDropoff);
            if (lf && lr) return { pathLen: lf.len || 1, built: false };

            // Budget check to avoid spike after heap reset
            if (heap.budgetUsed >= MAX_PATH_REBUILDS_PER_TICK_PER_HOME) {
                // Can't rebuild now. Use known path len if any; else a cheap approximation.
                const known = getKnownPathLen(pickupId);
                return { pathLen: known || dropoffPos.getRangeTo(pickupPos), built: false };
            }

            heap.budgetUsed++;

            // Compute both directions (prefer complete, else just record approximate len)
            const f = computePathData(dropoffPos, pickupPos, pathMemo); // dropoff -> pickup
            const r = computePathData(pickupPos, dropoffPos, pathMemo); // pickup -> dropoff

            const pathLen = (f && f.len) ? f.len : (dropoffPos.getRangeTo(pickupPos) || 1);
            recordPathLen(pickupId, pathLen);

            if (f.points && f.points.length) setLane(laneKeyToPickup, f.points, pathLen, dropoffPos, pickupPos);
            if (r.points && r.points.length) setLane(laneKeyToDropoff, r.points, (r.len || pathLen), pickupPos, dropoffPos);

            return { pathLen, built: true };
        };

        entries.forEach(({ name, entry, enabled }) => {
            if (!enabled || !entry || !Array.isArray(entry.sourcesInfo)) return;

            entry.sourcesInfo.forEach(source => {
                if (!source || !source.id) return;

                const hasContainer = !!(source.containerId && source.containerPos);
                const pickupId = hasContainer ? source.containerId : source.id;

                const pickupPos = hasContainer
                    ? toRoomPosition(source.containerPos)
                    : new RoomPosition(source.x, source.y, name);

                if (!pickupPos) return;

                const missionName = hasContainer
                    ? `remote:haul:${name}:${source.containerId}`
                    : `remote:haul:${name}:drop:${source.id}`;

                const census = getMissionCensus(missionName);

                const dropoffPos = dropoffTarget.pos;

                // Stable, deterministic lane key.
                const laneKeyBase = `rhaul:${room.name}:${pickupId}:${dropoffTarget.id}`;
                const laneKeyToPickup = `${laneKeyBase}:F`;
                const laneKeyToDropoff = `${laneKeyBase}:R`;

                // Get/refresh lane + pathLen without writing big blobs to Memory
                let pathLen = getKnownPathLen(pickupId) || 1;

                // If lanes are missing/expired, try to rebuild (rate-limited).
                const rebuilt = maybeRebuildLanes(pickupId, dropoffPos, pickupPos, laneKeyToPickup, laneKeyToDropoff);
                pathLen = rebuilt.pathLen || pathLen;

                const roundTrip = (pathLen * 2) + TRANSFER_BUFFER_TICKS;
                const distanceScale = 1 + Math.max(0, pathLen - DISTANCE_SOFT_CAP) * DISTANCE_SCALE_PER_TILE;

                const requiredCarryParts = Math.ceil((ENERGY_PER_TICK * roundTrip * distanceScale) / 50);
                const reqCount = Math.max(1, Math.ceil(requiredCarryParts / carryParts));

                debug('mission.remote.haul',
                    `[RemoteHaul] ${room.name} -> ${name} mode=${hasContainer ? 'container' : 'drop'} ` +
                    `pickup=${pickupId} path=${pathLen} carryParts=${carryParts} req=${reqCount} lane=${laneKeyBase}` +
                    `${rebuilt.built ? ' (rebuilt)' : ''}`);

                missions.push({
                    name: missionName,
                    type: 'remote_haul',
                    archetype: 'remote_hauler',
                    requirements: {
                        archetype: 'remote_hauler',
                        count: reqCount,
                        maxCarryParts: MAX_REMOTE_HAULER_CARRY_PARTS,
                        spawnFromFleet: true,
                    },
                    data: {
                        // Explicit owner so role.universal can read lanes from the right room
                        homeRoom: room.name,

                        remoteRoom: name,
                        pickupId: pickupId,
                        pickupPos: { x: pickupPos.x, y: pickupPos.y, roomName: pickupPos.roomName },
                        dropoffId: dropoffTarget.id,
                        dropoffPos: { x: dropoffTarget.pos.x, y: dropoffTarget.pos.y, roomName: dropoffTarget.pos.roomName },
                        resourceType: RESOURCE_ENERGY,
                        pickupMode: hasContainer ? 'container' : 'drop',
                        pickupRange: hasContainer ? 1 : 2,

                        // Movement lane info (directional)
                        laneKeyToPickup: laneKeyToPickup,
                        laneKeyToDropoff: laneKeyToDropoff,

                        // Back-compat: keep a default laneKey
                        laneKey: laneKeyToPickup,
                        laneSig: targetSignature,
                    },
                    priority: 70,
                    census: census,
                });
            });
        });
    },
};