// admiral/tactics/assault/solo/soloPlanner.js
//
// Drop-in SOLO planner that picks a 1-tick step using the assault combat costmatrix.
// - Works best for ENGAGE (same-room) micro: avoids "red" danger tiles, does simple kiting for ranged.
// - For cross-room / non-visible goals, it safely falls back to the caller's moveTarget+range.
//
// Expected usage (minimal changes):
//   const soloPlanner = require('managers_admiral_tactics_assault_solo_soloPlanner');
//   const plan = soloPlanner.plan(creep, runtime, target, routeTarget);
//   // then feed plan.moveTarget + plan.range into your existing actionPlan, OR just return plan + actions.
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

    // Construction sites can also block (rare, but safe)
    const sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y);
    if (sites && sites.length) {
        for (const cs of sites) {
            // Only roads/containers/ramparts are walkable-ish; but construction sites are not yet structures.
            // Screeps rules: most construction sites block movement except roads/containers/ramparts? (varies by server mods)
            // We'll be conservative: only allow road/rampart/container sites.
            const t = cs.structureType;
            if (t !== STRUCTURE_ROAD && t !== STRUCTURE_CONTAINER && t !== STRUCTURE_RAMPART) return false;
        }
    }

    return true;
}

function clamp01(v) {
    if (!Number.isFinite(v)) return 0;
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
}

function chooseDesiredRange(creep, runtime, target) {
    // Keep compatible with your existing solo/actionPlan.js
    if (runtime && runtime.phase === 'RETREAT') return 2;
    if (runtime && runtime.phase === 'ENGAGE' && target) {
        const hasRanged = creep.getActiveBodyparts(RANGED_ATTACK) > 0;
        return hasRanged ? 3 : 1;
    }
    return 1;
}

/**
 * Scores a candidate tile.
 *
 * Lower is better.
 * Components:
 * - dangerCost from combat matrix (dominant)
 * - distance shaping toward goal (or keeping at desired range)
 * - mild edge/border penalty so you don't get stuck on exits unless you intend to
 */
function scoreTile(room, costs, pos, goalPos, desiredRange, opts) {
    const {
        dangerWeight = 1.0,          // danger dominates
        distWeight = 4.0,            // how much to care about progress
        rangeWeight = 6.0,           // how much to care about staying at desired range (when engaging)
        borderPenalty = 25,          // avoid exits (you already have border costs in matrix too)
        preferNotOnGoal = false,     // if you want to avoid standing on target (not used by default)
    } = opts || {};

    const c = costs ? costs.get(pos.x, pos.y) : 0;
    if (c === 255) return Infinity;

    let s = 0;

    // Combat danger cost
    s += (c * dangerWeight);

    // Border penalty (additional to matrix) — only inside room
    if (isBorderPos(pos)) s += borderPenalty;

    if (goalPos && goalPos.roomName === room.name) {
        const d = pos.getRangeTo(goalPos);

        // If desiredRange is set (ENGAGE), shape around that range (kiting / spacing).
        // Example: ranged wants d ~= 3; melee wants d ~= 1
        if (Number.isFinite(desiredRange) && desiredRange >= 0) {
            s += (Math.abs(d - desiredRange) * rangeWeight);
        }

        // Also lightly prefer closer progress (helps when no target / travelling within room)
        s += (d * distWeight);

        if (preferNotOnGoal && d === 0) s += 10;
    }

    return s;
}

function pickBestStep(creep, goalPos, desiredRange, roomCallback, opts) {
    const room = creep.room;
    if (!room) return null;

    const costs = roomCallback ? roomCallback(room.name) : null;

    // If we can't build/obtain a matrix, don't try to micro.
    if (!costs) return null;

    let best = null;
    let bestScore = Infinity;

    // Consider stay-put first (important for HOLD / "don't step into red just to move")
    const here = creep.pos;
    if (isPassable(room, here, creep.id)) {
        const s0 = scoreTile(room, costs, here, goalPos, desiredRange, opts);
        best = here;
        bestScore = s0;
    }

    for (const dir of DIRS) {
        const v = DIR_VECTORS[dir];
        const nx = here.x + v.dx;
        const ny = here.y + v.dy;

        // Stay in bounds
        if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;

        const np = new RoomPosition(nx, ny, room.name);
        if (!isPassable(room, np, creep.id)) continue;

        const s = scoreTile(room, costs, np, goalPos, desiredRange, opts);
        if (s < bestScore) {
            bestScore = s;
            best = np;
        }
    }

    return best ? { pos: best, score: bestScore } : null;
}

/**
 * Main entry.
 */
function plan(creep, runtime, target, routeTarget, opts) {
    const goalPos = toRoomPosition((runtime && runtime.phase === 'ENGAGE' && target) ? target.pos : routeTarget);
    const desiredRange = chooseDesiredRange(creep, runtime, target);

    // For cross-room goals, let normal moveTo handle multi-room pathing.
    if (!goalPos || goalPos.roomName !== creep.room.name) {
        return {
            moveTarget: goalPos ? { x: goalPos.x, y: goalPos.y, roomName: goalPos.roomName } : null,
            range: (runtime && runtime.phase === 'ENGAGE' && target)
                ? (creep.getActiveBodyparts(RANGED_ATTACK) > 0 ? 3 : 1)
                : (runtime && runtime.phase === 'RETREAT' ? 2 : 1),
            reason: 'fallback:cross-room-or-no-goal'
        };
    }

    // Build matrix callback (cached inside the closure)
    // You can pass hostiles/flags via opts if you want; current combatMatrix pulls from room cache internally.
    const roomCallback = makeAssaultCombatRoomCallback({
        avoidBorders: true,
        borderCost: 10,
        considerCreeps: false
    });

    // Tune weights a little by phase
    const phase = runtime && runtime.phase ? runtime.phase : 'UNKNOWN';
    const hasRanged = creep.getActiveBodyparts(RANGED_ATTACK) > 0;

    const hp = creep.hitsMax > 0 ? creep.hits / creep.hitsMax : 1;
    const lowHp = clamp01(1 - hp); // 0..1, higher means more hurt

    const scoreOpts = Object.assign({
        dangerWeight: 1.0 + (lowHp * 0.8),      // more scared when hurt
        distWeight: (phase === 'ENGAGE' ? 1.5 : 3.5),
        rangeWeight: (phase === 'ENGAGE' ? (hasRanged ? 7.0 : 5.0) : 2.0),
        borderPenalty: 25
    }, opts && opts.score);

    const picked = pickBestStep(creep, goalPos, (phase === 'ENGAGE' ? desiredRange : null), roomCallback, scoreOpts);
    if (!picked || !picked.pos) {
        return {
            moveTarget: { x: goalPos.x, y: goalPos.y, roomName: goalPos.roomName },
            range: (phase === 'ENGAGE' && target) ? desiredRange : 1,
            reason: 'fallback:no-step'
        };
    }

    // If the "best" is our current tile, just hold (range 0 makes executors try to stand still if they use moveTo).
    // Safer: return moveTarget=null so your executor can skip moving if it wants.
    const next = picked.pos;

    // ✅ HOLD FIX — if best tile is current tile, do NOT issue movement
    if (next.x === creep.pos.x && next.y === creep.pos.y) {
        return {
            moveTarget: null,
            range: 0,
            reason: 'hold:best-is-stay'
        };
    }

    return {
        moveTarget: { x: next.x, y: next.y, roomName: next.roomName },
        range: 0,
        reason: 'micro:matrix-step'
    };
}

module.exports = {
    plan
};