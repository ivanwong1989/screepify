'use strict';

const heap = require('utils_heap');

const DEFAULT_LANE_TTL = 10000;
const DEFAULT_MAX_REBUILDS_PER_TICK = 2;
const DEFAULT_LANE_RESERVED_TILE_COST = 30;
const DEFAULT_LANE_RESERVED_NEIGHBOR_COST = 8;
const DEFAULT_LANE_SHARED_PREFIX_STEPS = 3;
const DEFAULT_PICKUP_END_MIN_RANGE = 1;

let _cmCacheTick = -1;
let _cmCache = Object.create(null);

const isFresh = (t, ttl) => (t != null) && (Game.time - t <= ttl);

const getRoomHeapCache = (homeRoom) => {
    const store = heap.getStore('remoteHaul', { ttl: null });
    if (!store.rooms || typeof store.rooms !== 'object') {
        store.rooms = Object.create(null);
    }

    let r = store.rooms[homeRoom];
    if (!r) {
        r = {
            sig: null,
            lanes: Object.create(null),
            meta: Object.create(null),
            budgetTick: -1,
            budgetUsed: 0,
        };
    }
    store.rooms[homeRoom] = r;

    if (r.budgetTick !== Game.time) {
        r.budgetTick = Game.time;
        r.budgetUsed = 0;
    }
    return r;
};

const getPathingCostMatrix = (roomName) => {
    if (_cmCacheTick !== Game.time) {
        _cmCacheTick = Game.time;
        _cmCache = Object.create(null);
    }
    if (Object.prototype.hasOwnProperty.call(_cmCache, roomName)) return _cmCache[roomName];

    const room = Game.rooms[roomName];
    if (!room) {
        _cmCache[roomName] = null;
        return null;
    }

    const cm = new PathFinder.CostMatrix();
    const structures = room.find(FIND_STRUCTURES);
    for (let i = 0; i < structures.length; i++) {
        const s = structures[i];
        if (!s) continue;

        if (s.structureType === STRUCTURE_ROAD) {
            cm.set(s.pos.x, s.pos.y, 1);
            continue;
        }
        if (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_PORTAL || s.structureType === STRUCTURE_EXTRACTOR) {
            continue;
        }
        if (s.structureType === STRUCTURE_RAMPART && (s.my || s.isPublic)) {
            continue;
        }
        cm.set(s.pos.x, s.pos.y, 255);
    }

    _cmCache[roomName] = cm;
    return cm;
};

const xyToIndex = (x, y) => (y * 50) + x;
const indexToXY = (idx) => ({ x: idx % 50, y: Math.floor(idx / 50) });

const getRoomReservations = (reservations, roomName) => {
    let roomRes = reservations[roomName];
    if (!roomRes) {
        roomRes = {
            core: Object.create(null),
            near: Object.create(null),
        };
        reservations[roomName] = roomRes;
    }
    return roomRes;
};

const addReservedPoint = (reservations, roomName, x, y, kind) => {
    if (x < 0 || x > 49 || y < 0 || y > 49) return;
    const idx = xyToIndex(x, y);
    const roomRes = getRoomReservations(reservations, roomName);
    const map = kind === 'core' ? roomRes.core : roomRes.near;
    map[idx] = (map[idx] || 0) + 1;
};

const reserveLanePoints = (reservations, points, sharedPrefixSteps) => {
    if (!Array.isArray(points) || points.length === 0) return;
    const skip = Math.max(0, Math.min(points.length - 1, sharedPrefixSteps || 0));

    for (let i = skip; i < points.length; i++) {
        const p = points[i];
        if (!p) continue;
        addReservedPoint(reservations, p.r, p.x, p.y, 'core');

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                addReservedPoint(reservations, p.r, p.x + dx, p.y + dy, 'near');
            }
        }
    }
};

const buildHardBlocksByRoom = (blockedTiles) => {
    const byRoom = Object.create(null);
    if (!Array.isArray(blockedTiles) || blockedTiles.length === 0) return byRoom;

    for (let i = 0; i < blockedTiles.length; i++) {
        const p = blockedTiles[i];
        if (!p || !p.roomName) continue;
        if (p.x < 0 || p.x > 49 || p.y < 0 || p.y > 49) continue;

        let roomMap = byRoom[p.roomName];
        if (!roomMap) {
            roomMap = Object.create(null);
            byRoom[p.roomName] = roomMap;
        }
        roomMap[xyToIndex(p.x, p.y)] = 1;
    }

    return byRoom;
};

const makeReservedRoomCallback = (reservations, tilePenalty, neighborPenalty, blockedTiles) => {
    const hardBlocksByRoom = buildHardBlocksByRoom(blockedTiles);
    const compiled = Object.create(null);

    const getCompiled = (roomName) => {
        let c = compiled[roomName];
        if (c) return c;

        const hardMap = hardBlocksByRoom[roomName];
        const hardKeys = hardMap ? Object.keys(hardMap) : [];
        const hard = new Array(hardKeys.length);
        for (let i = 0; i < hardKeys.length; i++) {
            hard[i] = Number(hardKeys[i]);
        }

        const roomRes = reservations[roomName];
        if (!roomRes) {
            c = { core: null, near: null, hard };
            compiled[roomName] = c;
            return c;
        }

        const coreKeys = Object.keys(roomRes.core);
        const nearKeys = Object.keys(roomRes.near);

        const core = new Array(coreKeys.length);
        for (let i = 0; i < coreKeys.length; i++) {
            const idx = Number(coreKeys[i]);
            core[i] = { idx, count: roomRes.core[idx] || 0 };
        }

        const near = new Array(nearKeys.length);
        for (let i = 0; i < nearKeys.length; i++) {
            const idx = Number(nearKeys[i]);
            near[i] = { idx, count: roomRes.near[idx] || 0 };
        }

        c = { core, near, hard };
        compiled[roomName] = c;
        return c;
    };

    return (roomName) => {
        const base = getPathingCostMatrix(roomName);
        const c = getCompiled(roomName);
        const hasHardBlocks = Array.isArray(c.hard) && c.hard.length > 0;
        if (!c.core && !c.near && !hasHardBlocks) return base || undefined;

        const cm = base ? base.clone() : new PathFinder.CostMatrix();

        const hard = c.hard || [];
        for (let i = 0; i < hard.length; i++) {
            const idx = hard[i];
            const { x, y } = indexToXY(idx);
            cm.set(x, y, 255);
        }

        const core = c.core || [];
        for (let i = 0; i < core.length; i++) {
            const idx = core[i].idx;
            const count = core[i].count;
            if (!count) continue;

            const { x, y } = indexToXY(idx);
            const existing = cm.get(x, y);
            if (existing >= 255) continue;
            const next = Math.min(254, existing + (count * tilePenalty));
            cm.set(x, y, next);
        }

        const near = c.near || [];
        for (let i = 0; i < near.length; i++) {
            const idx = near[i].idx;
            const count = near[i].count;
            if (!count) continue;

            const { x, y } = indexToXY(idx);
            const existing = cm.get(x, y);
            if (existing >= 255) continue;
            const next = Math.min(254, existing + (count * neighborPenalty));
            cm.set(x, y, next);
        }

        return cm;
    };
};

const isWalkablePoint = (p) => {
    if (!p || !p.r) return false;
    if (p.x < 0 || p.x > 49 || p.y < 0 || p.y > 49) return false;

    const terrain = Game.map.getRoomTerrain(p.r);
    if (!terrain || terrain.get(p.x, p.y) === TERRAIN_MASK_WALL) return false;

    const room = Game.rooms[p.r];
    if (!room) return true;

    const structures = room.lookForAt(LOOK_STRUCTURES, p.x, p.y);
    for (let i = 0; i < structures.length; i++) {
        const s = structures[i];
        if (!s) continue;
        if (s.structureType === STRUCTURE_ROAD) continue;
        if (s.structureType === STRUCTURE_CONTAINER) continue;
        if (s.structureType === STRUCTURE_PORTAL) continue;
        if (s.structureType === STRUCTURE_EXTRACTOR) continue;
        if (s.structureType === STRUCTURE_RAMPART && (s.my || s.isPublic)) continue;
        return false;
    }
    return true;
};

const toPacked = (p) => ({ r: p.roomName, x: p.x, y: p.y });

const buildBridgePath = (from, to) => {
    if (!from || !to) return null;

    const fromPos = new RoomPosition(from.x, from.y, from.r);
    const toPos = new RoomPosition(to.x, to.y, to.r);
    const res = PathFinder.search(fromPos, { pos: toPos, range: 0 }, {
        maxOps: 5000,
        plainCost: 2,
        swampCost: 10,
        roomCallback: (roomName) => getPathingCostMatrix(roomName) || undefined,
    });

    if (res.incomplete || !Array.isArray(res.path) || res.path.length === 0) return null;
    return res.path.map(toPacked);
};

const normalizeRoomCrossings = (points) => {
    if (!Array.isArray(points) || points.length < 2) return points;

    for (let i = 1; i < points.length; i++) {
        const prevPrev = i >= 2 ? points[i - 2] : null;
        const prev = points[i - 1];
        const curr = points[i];
        const next = i + 1 < points.length ? points[i + 1] : null;
        if (!prev || !curr) continue;
        if (prev.r === curr.r) continue;

        const eastCross = prev.x === 49 && curr.x === 0;
        const westCross = prev.x === 0 && curr.x === 49;
        const southCross = prev.y === 49 && curr.y === 0;
        const northCross = prev.y === 0 && curr.y === 49;

        if (eastCross || westCross) {
            const prevInnerX = eastCross ? 48 : 1;
            const currInnerX = eastCross ? 1 : 48;

            let targetY = prev.y;
            if (prevPrev && prevPrev.r === prev.r && prevPrev.x === prevInnerX) targetY = prevPrev.y;
            else if (next && next.r === curr.r && next.x === currInnerX) targetY = next.y;

            prev.y = targetY;
            curr.y = targetY;
            if (prevPrev && prevPrev.r === prev.r && prevPrev.x === prevInnerX) prevPrev.y = targetY;
            if (next && next.r === curr.r && next.x === currInnerX) next.y = targetY;
        } else if (southCross || northCross) {
            const prevInnerY = southCross ? 48 : 1;
            const currInnerY = southCross ? 1 : 48;

            let targetX = prev.x;
            if (prevPrev && prevPrev.r === prev.r && prevPrev.y === prevInnerY) targetX = prevPrev.x;
            else if (next && next.r === curr.r && next.y === currInnerY) targetX = next.x;

            prev.x = targetX;
            curr.x = targetX;
            if (prevPrev && prevPrev.r === prev.r && prevPrev.y === prevInnerY) prevPrev.x = targetX;
            if (next && next.r === curr.r && next.y === currInnerY) next.x = targetX;
        }
    }

    return points;
};

const isAdjacentStep = (a, b) => {
    if (!a || !b) return false;

    if (a.r === b.r) {
        const dx = Math.abs(a.x - b.x);
        const dy = Math.abs(a.y - b.y);
        return (dx <= 1 && dy <= 1) && (dx + dy > 0);
    }

    const eastCross = a.x === 49 && b.x === 0 && a.y === b.y;
    const westCross = a.x === 0 && b.x === 49 && a.y === b.y;
    const southCross = a.y === 49 && b.y === 0 && a.x === b.x;
    const northCross = a.y === 0 && b.y === 49 && a.x === b.x;
    return eastCross || westCross || southCross || northCross;
};

const reconcilePathContinuity = (points) => {
    if (!Array.isArray(points) || points.length < 2) return points;

    const out = [];
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (!p) continue;
        if (!isWalkablePoint(p)) continue;

        const last = out.length ? out[out.length - 1] : null;
        if (last && last.r === p.r && last.x === p.x && last.y === p.y) continue;

        if (!last) {
            out.push(p);
            continue;
        }
        if (isAdjacentStep(last, p)) {
            out.push(p);
            continue;
        }

        const bridge = buildBridgePath(last, p);
        if (bridge && bridge.length > 0) {
            for (let j = 0; j < bridge.length; j++) {
                const b = bridge[j];
                if (!b || !isWalkablePoint(b)) continue;
                const prev = out.length ? out[out.length - 1] : null;
                if (prev && prev.r === b.r && prev.x === b.x && prev.y === b.y) continue;
                if (!prev || isAdjacentStep(prev, b)) out.push(b);
            }
        }
    }
    return out;
};

const packPathPoints = (path) => {
    const pts = [];
    if (Array.isArray(path)) {
        for (let i = 0; i < path.length; i++) {
            const p = path[i];
            if (!p) continue;
            pts.push({ r: p.roomName, x: p.x, y: p.y });
        }
    }
    return reconcilePathContinuity(normalizeRoomCrossings(pts));
};

const reversePackedPoints = (points) => {
    if (!Array.isArray(points) || points.length === 0) return null;
    const out = [];
    for (let i = points.length - 1; i >= 0; i--) {
        const p = points[i];
        if (!p) continue;
        out.push({ r: p.r, x: p.x, y: p.y });
    }
    return out.length ? out : null;
};

const trimPathEndTooCloseToTarget = (points, targetPos, minRange) => {
    if (!Array.isArray(points) || points.length === 0 || !targetPos) return points;
    const requiredRange = Number.isFinite(minRange) ? minRange : 1;
    if (requiredRange <= 0) return points;

    let end = points.length - 1;
    while (end >= 0) {
        const p = points[end];
        if (!p) {
            end--;
            continue;
        }
        if (p.r !== targetPos.roomName) break;

        const dx = Math.abs(p.x - targetPos.x);
        const dy = Math.abs(p.y - targetPos.y);
        const cheb = Math.max(dx, dy);
        if (cheb >= requiredRange) break;
        end--;
    }

    if (end < 0) return points;
    if (end === points.length - 1) return points;
    const trimmed = points.slice(0, end + 1);
    return trimmed.length ? trimmed : points;
};

const computePathData = (fromPos, toPos, memo, roomCallback) => {
    if (!fromPos || !toPos) return { len: 1, points: null, incomplete: true };

    const key = `${fromPos.roomName}:${fromPos.x},${fromPos.y}:${toPos.roomName}:${toPos.x},${toPos.y}`;
    if (!roomCallback && memo && memo.has(key)) return memo.get(key);

    const result = PathFinder.search(fromPos, { pos: toPos, range: 1 }, {
        maxOps: 4000,
        plainCost: 2,
        swampCost: 10,
        roomCallback: roomCallback || ((roomName) => getPathingCostMatrix(roomName) || undefined),
    });

    const len = result.incomplete
        ? fromPos.getRangeTo(toPos)
        : (result.path ? result.path.length : 0);
    const points = (!result.incomplete && result.path && result.path.length)
        ? packPathPoints(result.path)
        : null;

    const data = { len: len || 1, points, incomplete: !!result.incomplete };
    if (!roomCallback && memo) memo.set(key, data);
    return data;
};

const createLaneManager = (homeRoom, targetSignature, opts = {}) => {
    const laneTtl = Number.isFinite(opts.laneTtl) ? opts.laneTtl : DEFAULT_LANE_TTL;
    const maxRebuildsPerTick = Number.isFinite(opts.maxRebuildsPerTick)
        ? opts.maxRebuildsPerTick
        : DEFAULT_MAX_REBUILDS_PER_TICK;
    const reservedTilePenalty = Number.isFinite(opts.reservedTilePenalty)
        ? opts.reservedTilePenalty
        : DEFAULT_LANE_RESERVED_TILE_COST;
    const reservedNeighborPenalty = Number.isFinite(opts.reservedNeighborPenalty)
        ? opts.reservedNeighborPenalty
        : DEFAULT_LANE_RESERVED_NEIGHBOR_COST;
    const sharedPrefixSteps = Number.isFinite(opts.sharedPrefixSteps)
        ? opts.sharedPrefixSteps
        : DEFAULT_LANE_SHARED_PREFIX_STEPS;
    const pickupEndMinRange = Number.isFinite(opts.pickupEndMinRange)
        ? opts.pickupEndMinRange
        : DEFAULT_PICKUP_END_MIN_RANGE;

    const h = getRoomHeapCache(homeRoom);
    if (h.sig !== targetSignature) {
        h.sig = targetSignature;
        h.lanes = Object.create(null);
        h.meta = Object.create(null);
    }

    const reservations = Object.create(null);

    const getLane = (laneKey) => {
        const e = h.lanes[laneKey];
        if (!e) return null;
        if (e.sig !== targetSignature) return null;
        if (!e.p || !e.p.length) return null;
        if (!isFresh(e.t, laneTtl)) return null;
        return e;
    };

    const setLane = (laneKey, points, len, fromPos, toPos) => {
        h.lanes[laneKey] = {
            p: points,
            len,
            t: Game.time,
            sig: targetSignature,
            from: `${fromPos.roomName}:${fromPos.x},${fromPos.y}`,
            to: `${toPos.roomName}:${toPos.x},${toPos.y}`,
        };
    };

    const getKnownPathLen = (pickupId) => {
        const hm = h.meta[pickupId];
        if (hm && isFresh(hm.created, laneTtl) && hm.pathLen) return hm.pathLen;
        return null;
    };

    const recordPathLen = (pickupId, pathLen) => {
        h.meta[pickupId] = { pathLen, created: Game.time };
    };

    const seedReservationsFromFreshLanes = () => {
        const laneKeys = Object.keys(h.lanes || {});
        for (let i = 0; i < laneKeys.length; i++) {
            const laneKey = laneKeys[i];
            if (!laneKey || !laneKey.endsWith(':F')) continue;

            const lane = h.lanes[laneKey];
            const fresh = lane
                && lane.sig === targetSignature
                && Array.isArray(lane.p)
                && lane.p.length > 0
                && isFresh(lane.t, laneTtl);

            if (!fresh) {
                delete h.lanes[laneKey];
                continue;
            }

            reserveLanePoints(reservations, lane.p, sharedPrefixSteps);
        }
    };

    seedReservationsFromFreshLanes();

    const ensureLanes = (pickupId, dropoffPos, pickupPos, laneKeyToPickup, laneKeyToDropoff, laneOpts = {}) => {
        const lf = getLane(laneKeyToPickup);
        const lr = getLane(laneKeyToDropoff);
        if (lf && lr) return { pathLen: lf.len || 1, built: false };

        if (h.budgetUsed >= maxRebuildsPerTick) {
            const known = getKnownPathLen(pickupId);
            return { pathLen: known || dropoffPos.getRangeTo(pickupPos), built: false };
        }

        h.budgetUsed++;

        const blockedTiles = Array.isArray(laneOpts.blockedTiles) ? laneOpts.blockedTiles : null;
        const reservedRoomCallback = makeReservedRoomCallback(
            reservations,
            reservedTilePenalty,
            reservedNeighborPenalty,
            blockedTiles
        );
        const hardBlockOnlyRoomCallback = (roomName) => {
            const base = getPathingCostMatrix(roomName);
            const cm = base ? base.clone() : new PathFinder.CostMatrix();
            let applied = false;
            if (blockedTiles && blockedTiles.length > 0) {
                for (let i = 0; i < blockedTiles.length; i++) {
                    const p = blockedTiles[i];
                    if (!p || p.roomName !== roomName) continue;
                    if (p.x < 0 || p.x > 49 || p.y < 0 || p.y > 49) continue;
                    cm.set(p.x, p.y, 255);
                    applied = true;
                }
            }
            return applied ? cm : (base || undefined);
        };

        // Fast path: build forward lane first. Reverse search only when needed.
        let f = computePathData(dropoffPos, pickupPos, null, reservedRoomCallback);
        let r = null;

        if (!Array.isArray(f.points) || f.points.length < 1) {
            r = computePathData(pickupPos, dropoffPos, null, reservedRoomCallback);
        }

        // Fallback to unreserved pathing if separation penalties over-constrain a corridor.
        const noForwardPoints = !Array.isArray(f.points) || f.points.length < 1;
        const reverseIncomplete = !r || r.incomplete;
        if (f.incomplete && noForwardPoints && reverseIncomplete) {
            f = computePathData(dropoffPos, pickupPos, null, hardBlockOnlyRoomCallback);
            if (!Array.isArray(f.points) || f.points.length < 1) {
                r = computePathData(pickupPos, dropoffPos, null, hardBlockOnlyRoomCallback);
            }
        }

        const fPoints = (Array.isArray(f.points) && f.points.length >= 1) ? f.points : null;
        const rPoints = (r && Array.isArray(r.points) && r.points.length >= 1) ? r.points : null;
        const canonicalForwardPointsRaw = fPoints || reversePackedPoints(rPoints);
        const canonicalForwardPoints = trimPathEndTooCloseToTarget(
            canonicalForwardPointsRaw,
            pickupPos,
            pickupEndMinRange
        );

        const pathLen = (f && !f.incomplete && f.len)
            ? f.len
            : (r && !r.incomplete && r.len)
                ? r.len
                : (f && f.len)
                    ? f.len
                    : (r && r.len)
                        ? r.len
                        : (dropoffPos.getRangeTo(pickupPos) || 1);
        recordPathLen(pickupId, pathLen);

        if (canonicalForwardPoints && canonicalForwardPoints.length >= 1) {
            setLane(laneKeyToPickup, canonicalForwardPoints, pathLen, dropoffPos, pickupPos);
            const canonicalReversePoints = reversePackedPoints(canonicalForwardPoints);
            if (canonicalReversePoints && canonicalReversePoints.length >= 1) {
                setLane(laneKeyToDropoff, canonicalReversePoints, pathLen, pickupPos, dropoffPos);
            }
            reserveLanePoints(reservations, canonicalForwardPoints, sharedPrefixSteps);
            return { pathLen, built: true };
        }

        return { pathLen, built: false };
    };

    return {
        getKnownPathLen,
        ensureLanes,
    };
};

module.exports = {
    DEFAULT_LANE_TTL,
    DEFAULT_MAX_REBUILDS_PER_TICK,
    createLaneManager,
};
