const remoteUtils = require('managers_overseer_utils_overseer.remote');
const heap = require('utils_heap');


// Auto-road planner for remote harvesting:
// When we have vision in a remote room, we opportunistically place a small number of road construction sites
// from the nearest exit -> each source (inside the remote room only). Remote build workers will pick them up.
// Auto-road planner for remote harvesting:
// When we have vision in a remote room, we opportunistically place a small number of road construction sites
// using *cached remote haul lanes* only, so road placement matches hauler traffic.
//
// Supported cached formats (best-effort, all optional):
// - sourcesInfo[].laneKey -> lookup in Memory.lanes / room.memory.overseer.lanes
// - entry.lanesBySourceId[sourceId] -> array of {x,y,roomName} or RoomPosition-like
// - entry.lanes[laneKey] -> same
function getLaneStore(homeRoom) {
    // Try several common locations; use the first that looks like an object.
    if (homeRoom && homeRoom.memory && homeRoom.memory.overseer) {
        const o = homeRoom.memory.overseer;
        if (o.lanes && typeof o.lanes === 'object') return o.lanes;
        if (o.remoteLanes && typeof o.remoteLanes === 'object') return o.remoteLanes;
        if (o.traffic && o.traffic.lanes && typeof o.traffic.lanes === 'object') return o.traffic.lanes;
    }
    if (Memory && Memory.lanes && typeof Memory.lanes === 'object') return Memory.lanes;
    return null;
}

function normalizeLanePath(raw) {
    // Expect an array of positions; return [] if not.
    if (!raw) return [];
    const path = Array.isArray(raw) ? raw : (raw.path || raw.positions || raw.posList);
    if (!Array.isArray(path)) return [];

    // Normalize items to {x,y,roomName}
    const out = [];
    for (const p of path) {
        if (!p) continue;
        const x = (p.x != null) ? p.x : (p.pos && p.pos.x);
        const y = (p.y != null) ? p.y : (p.pos && p.pos.y);
        const roomName = (p.roomName != null) ? p.roomName : (p.pos && p.pos.roomName);
        if (x == null || y == null || !roomName) continue;
        out.push({ x, y, roomName });
    }
    return out;
}

function getCachedLanePathForSource(homeRoom, entry, sourceInfo) {
    if (!sourceInfo) return null;

    // 1) direct per-source path in intel
    if (entry) {
        if (entry.lanesBySourceId && entry.lanesBySourceId[sourceInfo.id]) return entry.lanesBySourceId[sourceInfo.id];
        if (entry.sourcePaths && entry.sourcePaths[sourceInfo.id]) return entry.sourcePaths[sourceInfo.id];
    }

    // 2) lane key per source -> lane store lookup
    const laneKey = sourceInfo.laneKey || sourceInfo.lane || sourceInfo.pathKey;
    if (laneKey) {
        const store = getLaneStore(homeRoom);
        if (store && store[laneKey]) return store[laneKey];
        if (entry && entry.lanes && entry.lanes[laneKey]) return entry.lanes[laneKey];
    }

    // 3) maybe sourceInfo already contains a path
    if (sourceInfo.path) return sourceInfo.path;

    return null;
}

function planRemoteHarvestRoads(homeRoom, remoteRoom, entry, cache, opts) {
    if (!homeRoom || !remoteRoom || !entry) return;
    const now = Game.time;

    const ROAD_PLAN_INTERVAL = (opts && opts.roadPlanInterval) || 200;
    const MAX_NEW_ROADS_PER_SCAN = (opts && opts.maxNewRoadSitesPerScan) || 3;

    // Throttle
    if (cache.lastRoadPlan && (now - cache.lastRoadPlan) < ROAD_PLAN_INTERVAL) return;

    // Safety: skip if hostile towers or hostiles present
    const hostileTowers = remoteRoom.find(FIND_HOSTILE_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_TOWER
    });
    if (hostileTowers && hostileTowers.length > 0) {
        cache.lastRoadPlan = now;
        return;
    }
    const hostiles = remoteRoom.find(FIND_HOSTILE_CREEPS);
    if (hostiles && hostiles.length > 0) {
        cache.lastRoadPlan = now;
        return;
    }

    const sourcesInfo = Array.isArray(entry.sourcesInfo) ? entry.sourcesInfo : [];
    if (sourcesInfo.length === 0) {
        cache.lastRoadPlan = now;
        return;
    }

    const terrain = remoteRoom.getTerrain();

// HARD LIMIT: keep total construction sites in the remote room low (prevents road-site spam).
// This caps *all* site types (roads, containers, etc.) to keep remote build focused.
const MAX_REMOTE_CONSTRUCTION_SITES = 3;
const existingSites = remoteRoom.find(FIND_CONSTRUCTION_SITES);
if (existingSites && existingSites.length >= MAX_REMOTE_CONSTRUCTION_SITES) {
    cache.lastRoadPlan = now;
    return;
}

    const isWall = (x, y) => (terrain.get(x, y) === TERRAIN_MASK_WALL);

    const hasBlocking = (pos) => {
        if (!pos) return true;
        if (isWall(pos.x, pos.y)) return true;

        const structs = pos.lookFor(LOOK_STRUCTURES);
        if (structs && structs.length > 0) {
            // If there's already a road, don't place another site.
            if (structs.some(s => s.structureType === STRUCTURE_ROAD)) return true;
            // Avoid placing on any other structure.
            return true;
        }
        const sites = pos.lookFor(LOOK_CONSTRUCTION_SITES);
        if (sites && sites.length > 0) return true;
        return false;
    };

    // ---- Lane helpers (matches mission.remote.haul.js format) ----
    // lanes[laneKey] = { p: [{r,x,y},...], len, t, sig, ... }
    const laneStores = [];
    const heapLanes = getHeapLaneStore();
    if (heapLanes) laneStores.push(heapLanes);
    if (homeRoom.memory && homeRoom.memory.overseer) {
        if (homeRoom.memory.overseer.lanes) laneStores.push(homeRoom.memory.overseer.lanes);
        if (homeRoom.memory.overseer.remoteLanes) laneStores.push(homeRoom.memory.overseer.remoteLanes);
        if (homeRoom.memory.overseer.traffic && homeRoom.memory.overseer.traffic.lanes) laneStores.push(homeRoom.memory.overseer.traffic.lanes);
    }
    if (Memory && Memory.lanes) laneStores.push(Memory.lanes);

    const lanePrefixFor = (pickupId) => `rhaul:${homeRoom.name}:${pickupId}:`;

    const normalizeLanePoint = (pt) => {
        if (!pt) return null;
        const roomName = pt.roomName || pt.r;
        const x = Number(pt.x);
        const y = Number(pt.y);
        if (!roomName || !Number.isFinite(x) || !Number.isFinite(y)) return null;
        if (x < 0 || x > 49 || y < 0 || y > 49) return null;
        return { roomName, x, y };
    };

    function getHeapLaneStore() {
        const root = heap.getStore('remoteHaul', { ttl: null });
        if (!root || !root.rooms || !homeRoom) return null;
        const roomStore = root.rooms[homeRoom.name];
        if (!roomStore || !roomStore.lanes || typeof roomStore.lanes !== 'object') return null;
        return roomStore.lanes;
    }

    const getBestLanePoints = (pickupId) => {
        const prefix = lanePrefixFor(pickupId);
        let best = null;

        for (const store of laneStores) {
            if (!store) continue;
            for (const k in store) {
                if (!k || k.indexOf(prefix) !== 0) continue;

                // Prefer forward (dropoff->pickup) lanes when available.
                const isForward = k.endsWith(':F');
                const lane = store[k];
                if (!lane || !lane.p || !lane.p.length) continue;

                const t = lane.t || 0;

                if (!best) {
                    best = { isForward, t, points: lane.p };
                    continue;
                }

                // Selection: forward beats reverse; within same direction pick freshest.
                if (best.isForward !== isForward) {
                    if (isForward) best = { isForward, t, points: lane.p };
                } else if (t > best.t) {
                    best = { isForward, t, points: lane.p };
                }
            }
        }

        return best ? best.points : null;
    };

    const layRoadsFromPoints = (rawPoints, sourcePos) => {
        if (!rawPoints || rawPoints.length === 0) return 0;

        let placed = 0;

        for (let i = 0; i < rawPoints.length; i++) {
            if (placed >= MAX_NEW_ROADS_PER_SCAN) break;

            // Space road sites out to reduce total site count (every 2 tiles).
            if ((i & 1) === 1) continue;

            const pt = normalizeLanePoint(rawPoints[i]);
            if (!pt) continue;

            // CRITICAL: only lay roads on tiles that are in the remote room.
            if (pt.roomName !== remoteRoom.name) continue;

            // Skip mining ring near source.
            if (sourcePos && Math.abs(pt.x - sourcePos.x) <= 1 && Math.abs(pt.y - sourcePos.y) <= 1) continue;

            const rp = new RoomPosition(pt.x, pt.y, pt.roomName);

            if (hasBlocking(rp)) continue;

            const code = remoteRoom.createConstructionSite(pt.x, pt.y, STRUCTURE_ROAD);
            if (code === OK) {
                placed++;
            } else if (code === ERR_FULL) {
                return placed;
            } else {
                // ignore
            }
        }

        return placed;
    };

    // ---- Main loop: for each source, prefer lane-based road laying ----
    let totalPlaced = 0;

    for (const si of sourcesInfo) {
        if (totalPlaced >= MAX_NEW_ROADS_PER_SCAN) break;

        const src = (si && si.id) ? Game.getObjectById(si.id) : null;
        const source = src || (remoteRoom.find(FIND_SOURCES).find(s => s.id === (si && si.id)));
        if (!source) continue;

        // Match remote haul pickupId logic: if container exists, pickupId is containerId; else sourceId
        const hasContainer = !!(si && si.containerId && si.containerPos);
        const pickupId = hasContainer ? si.containerId : source.id;

        // Try cached lane points first
        const lanePoints = getBestLanePoints(pickupId);

        if (!lanePoints || !lanePoints.length) continue;
        const placedNow = layRoadsFromPoints(lanePoints, source.pos);

        totalPlaced += placedNow;
    }

    cache.lastRoadPlan = now;
}
module.exports = {
    generate: function(room, intel, context, missions) {
        if (context.opState === 'EMERGENCY') return;

        if (!room.memory.overseer) room.memory.overseer = {};
        if (!room.memory.overseer.remoteBuildCache) room.memory.overseer.remoteBuildCache = {};

        // Clone cached entries to avoid leaking build-only additions into other missions this tick.
        const entries = [...remoteUtils.getRemoteEconomicContext(room, {
            opState: context.opState,
            maxScoutAge: 4000
        })];

        // Check for newly claimed rooms (often in skipRooms or filtered out of remote context)
        // We want to help build spawn and early infrastructure until RCL 2
        const remoteMem = room.memory.overseer.remote || {};
        const candidates = new Set([
            ...(remoteMem.skipRooms || []),
            ...Object.keys(remoteMem.rooms || {})
        ]);
        const existingNames = new Set(entries.map(e => e.name));

        candidates.forEach(roomName => {
            if (existingNames.has(roomName)) return;

            const remoteRoom = Game.rooms[roomName];
            const isMy = remoteRoom && remoteRoom.controller && remoteRoom.controller.my;
            const needsHelp = isMy && (remoteRoom.controller.level < 2 || remoteRoom.find(FIND_MY_SPAWNS).length === 0);
            if (needsHelp) {
                const sources = remoteRoom.find(FIND_SOURCES);
                const sourcesInfo = sources.map(s => ({ id: s.id, x: s.pos.x, y: s.pos.y }));
                
                entries.push({
                    name: roomName,
                    entry: { sourcesInfo },
                    room: remoteRoom,
                    enabled: true
                });
                existingNames.add(roomName);
            }
        });

        const MAX_REMOTE_SITES = 3;
        const REMOTE_SCAN_INTERVAL = 25;
        const STALE_SITE_TICKS = 2000;
        const remoteBuildWorkTarget = 4;

        entries.forEach(({ name, entry, room: remoteRoom, enabled }) => {
            const isMy = remoteRoom && remoteRoom.controller && remoteRoom.controller.my;
            const needsHelp = isMy && (remoteRoom.controller.level < 3 || remoteRoom.find(FIND_MY_SPAWNS).length === 0);

            if ((!enabled && !needsHelp) || !entry) return;

            let sites = [];
            if (remoteRoom) {
                sites = remoteRoom.find(FIND_CONSTRUCTION_SITES);
            } else if (Array.isArray(entry.sites) && entry.lastSites && (Game.time - entry.lastSites) <= STALE_SITE_TICKS) {
                sites = entry.sites;
            }

            const cacheRoot = room.memory.overseer.remoteBuildCache;
            if (!cacheRoot[name]) cacheRoot[name] = { lastScan: 0, targetIds: [] };
            const cache = cacheRoot[name];
            // Opportunistically place road construction sites in visible remote rooms (auto-road to sources)
            if (remoteRoom && enabled) {
                planRemoteHarvestRoads(room, remoteRoom, entry, cache);
            }

            const now = Game.time;
            const shouldScan = !cache.lastScan || (now - cache.lastScan) >= REMOTE_SCAN_INTERVAL;

            if (!sites || sites.length === 0) {
                cache.targetIds = [];
                cache.lastScan = now;
                return;
            }

            let selected = null;
            if (!shouldScan && cache.targetIds && cache.targetIds.length > 0) {
                const byId = new Map(sites.map(s => [s.id, s]));
                const cachedTargets = cache.targetIds.map(id => byId.get(id)).filter(s => s);
                if (cachedTargets.length > 0) selected = cachedTargets;
            }

            if (!selected) {
                const sorted = [...sites].sort((a, b) => {
                    const aRatio = a.progressTotal > 0 ? (a.progress / a.progressTotal) : 0;
                    const bRatio = b.progressTotal > 0 ? (b.progress / b.progressTotal) : 0;
                    return bRatio - aRatio;
                });

                selected = sorted.slice(0, Math.min(MAX_REMOTE_SITES, sorted.length));
                cache.targetIds = selected.map(s => s.id);
                cache.lastScan = now;
            }
            const sourceIds = Array.isArray(entry.sourcesInfo) ? entry.sourcesInfo.map(s => s.id) : [];
            const containerIds = Array.isArray(entry.sourcesInfo)
                ? entry.sourcesInfo.map(s => s.containerId).filter(id => id)
                : [];
            const prioritizeWithdraw = !!(entry && entry.prioritizeWithdraw);

            debug('mission.remote.build', `[RemoteBuild] ${room.name} -> ${name} targets=${selected.length}/${sites.length} ` +
                `requiredWork=${remoteBuildWorkTarget}`);

            selected.forEach(site => {
                const pos = site.pos || { x: site.x, y: site.y, roomName: site.roomName };
                if (!pos || pos.x === undefined || pos.y === undefined || !pos.roomName) return;
                const targetPos = { x: pos.x, y: pos.y, roomName: pos.roomName };
                missions.push({
                    name: `remote:build:${site.id}`,
                    type: 'remote_build',
                    archetype: 'remote_worker',
                    targetId: site.id,
                    targetPos: targetPos,
                    data: {
                        remoteRoom: name,
                        sourceIds: sourceIds,
                        containerIds: containerIds,
                        prioritizeWithdraw: prioritizeWithdraw
                    },
                    requirements: {
                        archetype: 'remote_worker',
                        requiredWork: remoteBuildWorkTarget,
                        minCount: 1,
                        maxCount: 2,
                        spawnFromFleet: true
                    },
                    priority: 55
                });
            });
        });
    }
};
