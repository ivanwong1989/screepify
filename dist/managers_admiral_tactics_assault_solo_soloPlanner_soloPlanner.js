// admiral/tactics/assault/solo/soloPlanner.js
//
// PF-backed SOLO *path* planner:
// - Given a goal position (anywhere), returns the next PF step (or hold if already in range).
// - Uses your assault combat cost matrix as an optional roomCallback (so strategy can pick safe anchors elsewhere).
// - Caches PF steps under runtime._soloPf (duo-style) and can be forced to recalc each tick.
//
// Exports:
//   plan(creep, runtime, goal, opts?) -> { moveTarget, range, reason, debug? }
//   Back-compat: plan(creep, runtime, target, routeTarget, opts?) where goal defaults to opts.goal || routeTarget || target.pos

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
// Main entry
// ============================================================


function plan(creep, runtime, goalOrTarget, maybeGoalOrOpts, maybeOpts) {
    // Supports two call styles:
    // 1) New:    plan(creep, runtime, goal, opts?)
    // 2) Legacy: plan(creep, runtime, target, routeTarget, opts?)  (goal defaults to opts.goal || routeTarget || target.pos)
    let goal = null;
    let opts = null;

    if (maybeOpts !== undefined) {
        // Legacy 5-arg signature
        const target = goalOrTarget;
        const routeTarget = maybeGoalOrOpts;
        opts = maybeOpts || {};
        goal = opts.goal || routeTarget || (target && (target.pos || target)) || null;
    } else {
        // New 3/4-arg signature
        goal = goalOrTarget;
        opts = maybeGoalOrOpts || {};
    }

    const goalPos = toRoomPosition(goal);
    if (!goalPos) {
        return { moveTarget: null, range: 0, reason: 'fallback:no-goal' };
    }

    // Range to consider "arrived". Defaults to 1 tile.
    const range = Number.isFinite(opts.range) ? opts.range : (Number.isFinite(opts.desiredRange) ? opts.desiredRange : 1);

    // Cross-room: keep letting your higher-level route planner do it.
    // PF still can do multi-room, but your existing system already handles strategic routing.
    if (goalPos.roomName !== creep.room.name) {
        return {
            moveTarget: { x: goalPos.x, y: goalPos.y, roomName: goalPos.roomName },
            range,
            reason: 'fallback:cross-room'
        };
    }

    // If we are already in range, hold.
    if (creep.pos.inRangeTo(goalPos.x, goalPos.y, range)) {
        return { moveTarget: null, range: 0, reason: 'hold:in-range' };
    }

    // --- PF cache memory ---
    const mem = getPfMemory(runtime);

    // Tick PF progress/stall (duo-style)
    const stallRepathTicks = Number.isFinite(opts.stallRepathTicks) ? opts.stallRepathTicks : 2;
    const purpose = opts.cacheKey || 'path';
    if (mem) {
        const p = getPathState(mem, purpose);
        tickProgress(p, posKey(creep.pos), stallRepathTicks);
    }

    // --- PF options ---
    const pathReuseTicks = Number.isFinite(opts.pathReuseTicks) ? opts.pathReuseTicks : 25;
    const forceRecalc = !!opts.forceRecalc;

    // Default roomCallback uses the assault combat matrix (optional).
    const combatRoomCallback = makeAssaultCombatRoomCallback({
        avoidBorders: true,
        borderCost: 10,
        considerCreeps: false
    });

    const useCombatCosts = (opts.useCombatCosts !== false);

    const pfRoomCallback = (roomName) => {
        if (typeof opts.roomCallback === 'function') return opts.roomCallback(roomName);

        // In visible rooms only.
        const room = Game.rooms[roomName];
        if (!room) return undefined;

        if (useCombatCosts) return combatRoomCallback(roomName);
        return undefined;
    };

    const pfRange = range;

    const { to: pfTo, ps } = pfStepToward(mem, purpose, creep, goalPos, pfRange, {
        maxRooms: 16,
        pathReuseTicks: forceRecalc ? 0 : pathReuseTicks,
        forceRecalc,
        roomCallback: pfRoomCallback
    });

    // If PF has no step, just fallback to direct goal (moveTo can handle local).
    if (!pfTo) {
        return {
            moveTarget: { x: goalPos.x, y: goalPos.y, roomName: goalPos.roomName },
            range,
            reason: 'fallback:no-pf-step'
        };
    }

    // If PF step is blocked dynamically, clear cache quickly (stall logic will repath).
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
            range,
            reason: 'fallback:pf-to-blocked'
        };
    }

    return {
        moveTarget: { x: pfTo.x, y: pfTo.y, roomName: pfTo.roomName },
        range: 0,
        reason: 'pf:step'
    };
}

module.exports = {
    plan
};