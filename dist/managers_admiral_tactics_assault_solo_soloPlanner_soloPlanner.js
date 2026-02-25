// admiral/tactics/assault/solo/soloPlanner.js
//
// PF-backed SOLO planner (duo-style spine):
// - Travel: PF single-step with cached directions (no 8-tile greedy).
// - Engage (has target): PF gives the spine step; combat matrix augments by locally picking a safer/better tile,
//   but strongly biased toward the PF step to prevent oscillation / random holding.
// - Includes path progress + stall → repath like duoPlanner.
//
// Exports:
//   plan(creep, runtime, target, routeTarget, opts?) -> { moveTarget, range, reason, debug? }

const { makeAssaultCombatRoomCallback } = require('managers_admiral_tactics_assault_common_combatMatrix');

const DIRS = [1, 2, 3, 4, 5, 6, 7, 8];
const DIR_VECTORS = {
    1: { dx: 0, dy: -1 },
    2: { dx: 1, dy: -1 },
    3: { dx: 1, dy: 0 },
    4: { dx: 1, dy: 1 },
    5: { dx: 0, dy: 1 },
    6: { dx: -1, dy: 1 },
    7: { dx: -1, dy: 0 },
    8: { dx: -1, dy: -1 }
};

function toRoomPosition(pos) {
    if (!pos) return null;
    if (pos instanceof RoomPosition) return pos;
    if (pos.pos) pos = pos.pos;
    if (pos.x == null || pos.y == null) return null;
    const roomName = pos.roomName || (pos.room && pos.room.name);
    if (!roomName) return null;
    return new RoomPosition(pos.x, pos.y, roomName);
}

function posKey(pos) {
    if (!pos) return null;
    return `${pos.roomName}:${pos.x}:${pos.y}`;
}

function clamp01(v) {
    if (!Number.isFinite(v)) return 0;
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
}

function isBorderPos(pos) {
    return !!pos && (pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49);
}

function isWalkableStructure(structure) {
    if (!structure) return true;
    if (structure.structureType === STRUCTURE_ROAD) return true;
    if (structure.structureType === STRUCTURE_CONTAINER) return true;
    if (structure.structureType === STRUCTURE_PORTAL) return true;
    if (structure.structureType === STRUCTURE_RAMPART) {
        if (structure.my) return true;
        return structure.isPublic === true;
    }
    return false;
}

function isPassable(room, pos, selfId) {
    if (!room || !pos) return false;

    const terrain = room.getTerrain().get(pos.x, pos.y);
    if (terrain === TERRAIN_MASK_WALL) return false;

    // Creeps block (except self)
    const creeps = room.lookForAt(LOOK_CREEPS, pos.x, pos.y);
    if (creeps && creeps.length) {
        for (const c of creeps) {
            if (c && c.id && c.id !== selfId) return false;
        }
    }

    // Unwalkable structures block
    const structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
    if (structures && structures.length) {
        for (const s of structures) {
            if (!isWalkableStructure(s)) return false;
        }
    }

    // Construction sites (conservative)
    const sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y);
    if (sites && sites.length) {
        for (const cs of sites) {
            const t = cs.structureType;
            if (t !== STRUCTURE_ROAD && t !== STRUCTURE_CONTAINER && t !== STRUCTURE_RAMPART) return false;
        }
    }

    return true;
}

function chooseDesiredRange(creep, runtime, target) {
    if (runtime && runtime.phase === 'RETREAT') return 2;
    if (runtime && runtime.phase === 'ENGAGE' && target) {
        const hasRanged = creep.getActiveBodyparts(RANGED_ATTACK) > 0;
        return hasRanged ? 3 : 1;
    }
    return 1;
}

function formatPos(pos) {
    if (!pos) return 'null';
    return `${pos.roomName}:${pos.x},${pos.y}`;
}

// ============================================================
// PF cache (duo-style, but stored under runtime._soloPf)
// ============================================================

function getPfMemory(runtime) {
    if (!runtime) return null;
    if (!runtime._soloPf || typeof runtime._soloPf !== 'object') {
        runtime._soloPf = { paths: {} };
    }
    return runtime._soloPf;
}

function getPathState(mem, purpose) {
    if (!mem || !purpose) return null;
    if (!mem.paths) mem.paths = {};
    if (!mem.paths[purpose]) {
        mem.paths[purpose] = {
            key: null,
            steps: [],
            idx: 0,
            lastRecalc: 0,
            stalledTicks: 0,
            lastToKey: null
        };
    }
    return mem.paths[purpose];
}

function resetPathState(ps, key) {
    if (!ps) return;
    ps.key = key || null;
    ps.steps = [];
    ps.idx = 0;
    ps.lastRecalc = 0;
    ps.stalledTicks = 0;
    ps.lastToKey = null;
}

function peekNextDir(ps) {
    if (!ps || !ps.steps || ps.idx >= ps.steps.length) return null;
    return ps.steps[ps.idx];
}

function dirToPos(fromPos, dir) {
    if (!fromPos || !dir) return null;
    const v = DIR_VECTORS[dir];
    if (!v) return null;
    const x = fromPos.x + v.dx;
    const y = fromPos.y + v.dy;
    if (x < 0 || x > 49 || y < 0 || y > 49) return null;
    return new RoomPosition(x, y, fromPos.roomName);
}

function packDirections(path, startPos) {
    if (!path || path.length === 0 || !startPos) return [];
    const dirs = [];
    let from = startPos;
    for (const step of path) {
        const dir = from.getDirectionTo(step.x, step.y);
        if (dir) dirs.push(dir);
        from = step;
    }
    return dirs;
}

function advanceIfProgress(ps, currentPosKey) {
    if (!ps || !ps.lastToKey) return false;
    if (ps.lastToKey !== currentPosKey) return false;
    ps.idx = Math.min(ps.idx + 1, ps.steps.length);
    ps.stalledTicks = 0;
    ps.lastToKey = null;
    return true;
}

function markStall(ps) {
    if (!ps) return;
    ps.stalledTicks = (ps.stalledTicks || 0) + 1;
}

function tickProgress(ps, currentPosKey, stallRepathTicks) {
    if (!ps) return { advanced: false, stalled: false };
    const advanced = advanceIfProgress(ps, currentPosKey);
    let stalled = false;

    // Only count a stall if we were expecting a move last tick.
    if (!advanced && ps.lastToKey) {
        stalled = true;
        markStall(ps);
        const threshold = Number.isFinite(stallRepathTicks) ? stallRepathTicks : 2;
        if ((ps.stalledTicks || 0) >= threshold) {
            ps.steps = [];
            ps.idx = 0;
            ps.lastToKey = null;
            ps.stalledTicks = 0;
        }
    }

    return { advanced, stalled };
}

function computePathSteps(fromPos, goal, extra = {}) {
    if (!fromPos || !goal || !goal.pos) return { steps: [], incomplete: true };

    const pf = PathFinder.search(
        fromPos,
        { pos: goal.pos, range: goal.range },
        {
            maxRooms: Number.isFinite(extra.maxRooms) ? extra.maxRooms : 16,
            roomCallback: extra.roomCallback
        }
    );

    if (!pf || !pf.path || pf.path.length === 0) {
        return { steps: [], incomplete: pf ? !!pf.incomplete : true };
    }

    return { steps: packDirections(pf.path, fromPos), incomplete: !!pf.incomplete };
}

function ensurePath(mem, purpose, fromPos, goal, opts) {
    const ps = getPathState(mem, purpose);
    if (!ps || !fromPos || !goal || !goal.pos) return ps;

    const pathReuseTicks = Number.isFinite(opts && opts.pathReuseTicks) ? opts.pathReuseTicks : 25;
    const forceRecalc = !!(opts && opts.forceRecalc);

    const reuseOk =
        !forceRecalc &&
        ps.key === goal.key &&
        ps.steps.length > 0 &&
        ps.idx < ps.steps.length &&
        (Game.time - ps.lastRecalc) <= pathReuseTicks;

    if (reuseOk) return ps;

    const result = computePathSteps(fromPos, goal, opts);
    ps.key = goal.key;
    ps.steps = result.steps;
    ps.idx = 0;
    ps.lastRecalc = Game.time;
    ps.stalledTicks = 0;
    ps.lastToKey = null;

    return ps;
}

function pfStepToward(mem, purpose, creep, goalPos, range, opts) {
    if (!creep || !creep.pos || !goalPos) return { dir: null, to: null, ps: null };

    const goal = {
        pos: goalPos,
        range: Number.isFinite(range) ? range : 1,
        key: `${purpose}:${goalPos.roomName}:${goalPos.x}:${goalPos.y}:r${Number.isFinite(range) ? range : 1}`
    };

    const ps = mem ? ensurePath(mem, purpose, creep.pos, goal, opts) : null;
    const dir = ps ? peekNextDir(ps) : null;

    if (!dir) {
        // No cached step; try compute ad-hoc (no cache)
        const result = computePathSteps(creep.pos, goal, opts);
        const adHocDir = (result.steps && result.steps.length > 0) ? result.steps[0] : null;
        if (!adHocDir) return { dir: null, to: null, ps: ps || null };
        const to = dirToPos(creep.pos, adHocDir);
        return { dir: adHocDir, to, ps: ps || null };
    }

    const to = dirToPos(creep.pos, dir);
    if (!to) return { dir: null, to: null, ps };

    // Track expected next pos for progress/stall accounting (duo-style)
    if (ps) ps.lastToKey = posKey(to);

    return { dir, to, ps };
}

// ============================================================
// Combat matrix augmented micro (PF spine + local adjustment)
// ============================================================

function scoreTile(room, costs, pos, goalPos, desiredRange, opts) {
    const {
        dangerWeight = 1.0,
        distWeight = 3.0,
        rangeWeight = 6.0,
        borderPenalty = 25,

        // PF spine bias: prefer the PF "to" tile strongly
        pfTo = null,
        pfPenalty = 20,

        // anti-oscillation
        prevPos = null
    } = opts || {};

    const c = costs ? costs.get(pos.x, pos.y) : 0;
    if (c === 255) return Infinity;

    let s = 0;

    // Combat danger cost
    s += (c * dangerWeight);

    // Border penalty
    if (isBorderPos(pos)) s += borderPenalty;

    // Range + progress shaping
    if (goalPos && goalPos.roomName === room.name) {
        const d = pos.getRangeTo(goalPos);
        if (Number.isFinite(desiredRange) && desiredRange >= 0) {
            s += (Math.abs(d - desiredRange) * rangeWeight);
        }
        s += (d * distWeight);
    }

    // PF spine: anything not the PF step gets a penalty (so PF remains the default)
    if (pfTo && !(pos.x === pfTo.x && pos.y === pfTo.y && pos.roomName === pfTo.roomName)) {
        s += pfPenalty;
    }

    // anti-oscillation: avoid stepping back to prevPos
    if (prevPos && pos.roomName === prevPos.roomName && pos.x === prevPos.x && pos.y === prevPos.y) {
        s += 50;
    }

    return s;
}

function pickCombatStep(creep, goalPos, desiredRange, roomCallback, opts) {
    const room = creep.room;
    if (!room) return null;

    const costs = roomCallback ? roomCallback(room.name) : null;
    if (!costs) return null;

    const here = creep.pos;

    let best = null;
    let bestScore = Infinity;

    // Candidates: PF-to (preferred), stay, and neighbors
    const candidates = [];

    if (opts && opts.pfTo) candidates.push(opts.pfTo);
    candidates.push(here);

    for (const dir of DIRS) {
        const v = DIR_VECTORS[dir];
        const nx = here.x + v.dx;
        const ny = here.y + v.dy;
        if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;
        candidates.push(new RoomPosition(nx, ny, room.name));
    }

    for (const p of candidates) {
        if (!p) continue;
        if (!isPassable(room, p, creep.id)) continue;

        const s = scoreTile(room, costs, p, goalPos, desiredRange, opts);
        if (s < bestScore) {
            bestScore = s;
            best = p;
        }
    }

    return best ? { pos: best, score: bestScore } : null;
}

// ============================================================
// Main entry
// ============================================================

function plan(creep, runtime, target, routeTarget, opts) {
    const phase = runtime && runtime.phase ? runtime.phase : 'UNKNOWN';
    const hasCombatTarget = (phase === 'ENGAGE' && !!target);

    const desiredRange = chooseDesiredRange(creep, runtime, target);

    // Goal for PF:
    // - ENGAGE with target: move toward target at desiredRange (kite/close)
    // - otherwise: move toward routeTarget (flag/waypoint)
    const goalPos = toRoomPosition(hasCombatTarget ? target.pos : routeTarget);

    if (!goalPos) {
        return { moveTarget: null, range: 0, reason: 'fallback:no-goal' };
    }

    // Cross-room: keep letting your higher-level route planner do it.
    // PF still can do multi-room, but your existing system already handles strategic routing.
    if (goalPos.roomName !== creep.room.name) {
        return {
            moveTarget: { x: goalPos.x, y: goalPos.y, roomName: goalPos.roomName },
            range: hasCombatTarget ? desiredRange : 1,
            reason: 'fallback:cross-room'
        };
    }

    // --- PF cache memory ---
    const mem = getPfMemory(runtime);

    // Tick PF progress/stall (duo-style)
    const stallRepathTicks = (opts && Number.isFinite(opts.stallRepathTicks)) ? opts.stallRepathTicks : 2;
    if (mem) {
        const p = getPathState(mem, hasCombatTarget ? 'engage' : 'travel');
        tickProgress(p, posKey(creep.pos), stallRepathTicks);
    }

    // --- PF options ---
    const pathReuseTicks = (opts && Number.isFinite(opts.pathReuseTicks)) ? opts.pathReuseTicks : 25;

    // Combat matrix callback (for micro scoring) — same as before
    const combatRoomCallback = makeAssaultCombatRoomCallback({
        avoidBorders: true,
        borderCost: 10,
        considerCreeps: false
    });

    // Travel PF: default roomCallback (undefined) works fine; but we bias away from borders a bit by using combat callback
    // ONLY for same-room planning (cheap + already cached elsewhere in your stack).
    // If you want “pure terrain PF”, set useCombatCostsForTravel=false.
    const useCombatCostsForTravel = true;

    const pfRoomCallback = (roomName) => {
        // In visible rooms only.
        const room = Game.rooms[roomName];
        if (!room) return undefined;

        if (hasCombatTarget) {
            // When fighting, PF itself should “see” the danger.
            return combatRoomCallback(roomName);
        }

        if (useCombatCostsForTravel) {
            // Travel: still avoid borders + mild danger, but PF is the spine (no local greedy)
            return combatRoomCallback(roomName);
        }

        return undefined;
    };

    // Determine goal range for PF
    const pfRange = hasCombatTarget ? desiredRange : 1;

    const { to: pfTo, ps } = pfStepToward(mem, hasCombatTarget ? 'engage' : 'travel', creep, goalPos, pfRange, {
        maxRooms: 16,
        pathReuseTicks,
        roomCallback: pfRoomCallback
    });

    // If PF has no step, just fallback to direct goal (moveTo can handle local)
    if (!pfTo) {
        return {
            moveTarget: { x: goalPos.x, y: goalPos.y, roomName: goalPos.roomName },
            range: hasCombatTarget ? desiredRange : 1,
            reason: 'fallback:no-pf-step'
        };
    }

    // --- TRAVEL: PF-only, never “hold while far away” ---
    if (!hasCombatTarget) {
        // If we are already “close enough”, allow hold.
        if (creep.pos.inRangeTo(goalPos.x, goalPos.y, 1)) {
            return { moveTarget: null, range: 0, reason: 'hold:travel-in-range' };
        }

        // If PF step is blocked dynamically, clear cache quickly (stall logic will repath)
        if (!isPassable(creep.room, pfTo, creep.id)) {
            if (ps) {
                // Nuke steps so next tick recomputes
                ps.steps = [];
                ps.idx = 0;
                ps.lastToKey = null;
                ps.stalledTicks = 0;
            }
            return {
                moveTarget: { x: goalPos.x, y: goalPos.y, roomName: goalPos.roomName },
                range: 1,
                reason: 'fallback:pf-to-blocked'
            };
        }

        return {
            moveTarget: { x: pfTo.x, y: pfTo.y, roomName: pfTo.roomName },
            range: 0,
            reason: 'pf:travel-step'
        };
    }

    // --- ENGAGE: PF spine + combat-matrix local adjustment ---
    const hp = creep.hitsMax > 0 ? creep.hits / creep.hitsMax : 1;
    const lowHp = clamp01(1 - hp);
    const hasRanged = creep.getActiveBodyparts(RANGED_ATTACK) > 0;

    const picked = pickCombatStep(
        creep,
        goalPos,
        desiredRange,
        combatRoomCallback,
        {
            dangerWeight: 1.0 + (lowHp * 0.8),
            distWeight: 1.5,
            rangeWeight: hasRanged ? 7.0 : 5.0,
            borderPenalty: 25,

            // PF spine bias: this is the main anti-jitter knob.
            pfTo,
            pfPenalty: (opts && opts.pfPenalty != null) ? opts.pfPenalty : 22,

            prevPos: opts && opts.prevPos ? opts.prevPos : null
        }
    );

    if (!picked || !picked.pos) {
        return {
            moveTarget: { x: pfTo.x, y: pfTo.y, roomName: pfTo.roomName },
            range: 0,
            reason: 'pf:engage-step-fallback'
        };
    }

    const next = picked.pos;

    // Allow holding ONLY if we are already in good engage posture
    // (prevents “hold while far away” but still allows actual kiting / stand-ground).
    const inDesiredBand = creep.pos.getRangeTo(goalPos) === desiredRange;
    const allowHold = inDesiredBand;

    if (next.x === creep.pos.x && next.y === creep.pos.y) {
        return allowHold
            ? { moveTarget: null, range: 0, reason: 'hold:engage-posture' }
            : { moveTarget: { x: pfTo.x, y: pfTo.y, roomName: pfTo.roomName }, range: 0, reason: 'pf:push-forward' };
    }

    return {
        moveTarget: { x: next.x, y: next.y, roomName: next.roomName },
        range: 0,
        reason: (next.x === pfTo.x && next.y === pfTo.y) ? 'pf:engage-spine' : 'micro:engage-augmented'
    };
}

module.exports = {
    plan
};