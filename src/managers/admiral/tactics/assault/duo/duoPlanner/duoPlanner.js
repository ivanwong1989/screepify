const COHESION_RANGE = 1;
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

function isSamePos(a, b) {
    if (!a || !b) return false;
    return a.roomName === b.roomName && a.x === b.x && a.y === b.y;
}

function isBorderPos(pos) {
    if (!pos) return false;
    return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
}

function isEdgeTile(pos) {
    return isBorderPos(pos);
}

// leader is attempting to move onto an edge tile while heading to another room
function needsPreCrossStaging(roomName, goalPos, leaderTo) {
    if (!goalPos || !leaderTo) return false;
    return goalPos.roomName !== roomName && isEdgeTile(leaderTo);
}

function getBorderCrossDir(pos) {
    if (!pos) return null;
    if (pos.x === 0) return 7;
    if (pos.x === 49) return 3;
    if (pos.y === 0) return 1;
    if (pos.y === 49) return 5;
    return null;
}

function getCohesion(leader, support, cohesionRange) {
    if (!leader || !support) return { cohesive: false, dist: Infinity, sameRoom: false };
    const sameRoom = leader.pos.roomName === support.pos.roomName;
    const dist = sameRoom ? leader.pos.getRangeTo(support.pos) : Infinity;
    const range = Number.isFinite(cohesionRange) ? cohesionRange : COHESION_RANGE;
    return { cohesive: sameRoom && dist <= range, dist, sameRoom };
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

function isClaimedByOther(movePlan, pos, planningCreep) {
    if (!movePlan || !movePlan.claimed || !pos) return false;
    const key = posKey(pos);
    if (!movePlan.claimed.has(key)) return false;
    if (!planningCreep || !movePlan.intent) return true;
    if (movePlan.intent.leader && planningCreep === movePlan.intent.leader.creep && movePlan.intent.leader.to && posKey(movePlan.intent.leader.to) === key) {
        return false;
    }
    if (movePlan.intent.support && planningCreep === movePlan.intent.support.creep && movePlan.intent.support.to && posKey(movePlan.intent.support.to) === key) {
        return false;
    }
    return true;
}

function allowedByVacating(movePlan, pos) {
    if (!movePlan || !movePlan.vacating || !pos) return false;
    return movePlan.vacating.has(posKey(pos));
}

function isPassableForSupport(room, pos, leader, support, movePlan) {
    if (!room || !pos) return false;
    const terrain = room.getTerrain().get(pos.x, pos.y);
    if (terrain === TERRAIN_MASK_WALL) return false;
    if (isClaimedByOther(movePlan, pos, support)) return false;
    const creeps = room.lookForAt(LOOK_CREEPS, pos.x, pos.y);
    if (creeps && creeps.length > 0) {
        for (const creep of creeps) {
            if (!leader || creep.id !== leader.id) {
                if (!support || creep.id !== support.id) {
                    if (allowedByVacating(movePlan, pos)) continue;
                    return false;
                }
            }
        }
    }
    const structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
    if (structures && structures.length > 0) {
        for (const structure of structures) {
            if (!isWalkableStructure(structure)) return false;
        }
    }
    return true;
}

function isPassableForLeader(room, pos, leader, support, movePlan) {
    if (!room || !pos) return false;
    const terrain = room.getTerrain().get(pos.x, pos.y);
    if (terrain === TERRAIN_MASK_WALL) return false;
    if (isClaimedByOther(movePlan, pos, leader)) return false;
    const creeps = room.lookForAt(LOOK_CREEPS, pos.x, pos.y);
    if (creeps && creeps.length > 0) {
        for (const creep of creeps) {
            if (!leader || creep.id !== leader.id) {
                if (!support || creep.id !== support.id) {
                    if (allowedByVacating(movePlan, pos)) continue;
                    return false;
                }
            }
        }
    }
    const structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
    if (structures && structures.length > 0) {
        for (const structure of structures) {
            if (!isWalkableStructure(structure)) return false;
        }
    }
    return true;
}

function buildMovePlan(leader, support, leaderTo, supportTo) {
    const plan = {
        intent: {
            leader: { creep: leader || null, from: leader ? leader.pos : null, to: leaderTo || null },
            support: { creep: support || null, from: support ? support.pos : null, to: supportTo || null }
        },
        vacating: new Set(),
        claimed: new Set()
    };
    const leaderFromKey = plan.intent.leader.from ? posKey(plan.intent.leader.from) : null;
    const leaderToKey = plan.intent.leader.to ? posKey(plan.intent.leader.to) : null;
    const supportFromKey = plan.intent.support.from ? posKey(plan.intent.support.from) : null;
    const supportToKey = plan.intent.support.to ? posKey(plan.intent.support.to) : null;
    if (leaderFromKey && leaderToKey && leaderFromKey !== leaderToKey) plan.vacating.add(leaderFromKey);
    if (supportFromKey && supportToKey && supportFromKey !== supportToKey) plan.vacating.add(supportFromKey);
    if (leaderToKey) plan.claimed.add(leaderToKey);
    if (supportToKey) plan.claimed.add(supportToKey);
    return plan;
}

function markVacating(plan, pos) {
    if (!plan || !pos) return;
    plan.vacating.add(posKey(pos));
}

function dirToPos(from, dir) {
    if (!from || !dir || !DIR_VECTORS[dir]) return null;
    const vec = DIR_VECTORS[dir];
    const x = from.x + vec.dx;
    const y = from.y + vec.dy;
    if (x < 0 || x > 49 || y < 0 || y > 49) return null;
    return new RoomPosition(x, y, from.roomName);
}

function getDirBetween(from, to) {
    if (!from || !to) return null;
    if (isSamePos(from, to)) return null;
    return from.getDirectionTo(to);
}

function clampRoomPos(pos) {
    if (!pos) return null;
    if (pos.x < 0 || pos.x > 49 || pos.y < 0 || pos.y > 49) return null;
    return pos;
}

function getAdjacentTo(pos) {
    if (!pos) return [];
    const out = [];
    for (const dir of DIRS) {
        const next = dirToPos(pos, dir);
        if (next) out.push(next);
    }
    return out;
}

function isCohesionOk(leaderTo, supportTo, cohesionRange, allowSplit) {
    if (!leaderTo || !supportTo) return false;
    if (leaderTo.roomName !== supportTo.roomName) return allowSplit;
    const range = Number.isFinite(cohesionRange) ? cohesionRange : COHESION_RANGE;
    return allowSplit ? true : leaderTo.getRangeTo(supportTo) <= range;
}

function isGoalReached(leaderPos, goal) {
    if (!leaderPos || !goal || !goal.pos) return false;
    if (goal.type === 'OCCUPY') return isSamePos(leaderPos, goal.pos);
    const range = Number.isFinite(goal.range) ? goal.range : 1;
    return leaderPos.getRangeTo(goal.pos) <= range;
}

function readMatrixCost(matrix, x, y) {
    if (!matrix || typeof matrix.get !== 'function') return 0;
    const v = matrix.get(x, y);
    return Number.isFinite(v) ? v : 0;
}

function getCombatMatrix(runtime, roomName) {
    if (!runtime || !runtime.roomCallback || !roomName) return null;
    try {
        const m = runtime.roomCallback(roomName);
        // roomCallback can return false to block the room in PF; treat that as no matrix for scoring
        if (m === false) return null;
        return m || null;
    } catch (e) {
        return null;
    }
}

function isUnsafeForSupport(room, pos, runtime, opts = {}) {
    if (!room || !pos) return true;
    // Exit tiles are considered unsafe unless explicitly allowed (cross/handshake).
    if (!opts.allowExit && isExitTile(pos)) return true;

    const combatMatrix = getCombatMatrix(runtime, room.name);
    if (!combatMatrix) return false; // no intel; don't hard-block

    const c = readMatrixCost(combatMatrix, pos.x, pos.y);
    if (!Number.isFinite(c)) return false;
    // Convention used elsewhere in your overlays:
    // - 255 is unwalkable
    // - >=60 is "melee-ish / lethal-ish"
    // - >=40 is "ranged danger band"
    if (c >= 255) return true;
    // NEW: stricter support rule
    const hard = Number.isFinite(opts.hardThreshold) ? opts.hardThreshold : 60;
    if (c >= hard) return true;

    return false;
}

function computeSupportCohesive(room, leader, support, leaderTo, leaderDir, formation, movePlan, runtime, cohesionRange, enemyPos) {
    if (!room || !leader || !support || !leaderTo) return null;

    const rangeMax = Number.isFinite(cohesionRange) ? cohesionRange : COHESION_RANGE;
    const preferred = Math.min(
        rangeMax,
        Number.isFinite(formation && formation.preferredCohesionRange)
            ? formation.preferredCohesionRange
            : 1
    );
    const candidates = [];


    // CombatMatrix "feel": use threat gradient to bias formation tiles.
    // - Lower matrix cost is preferred.
    // - Tiles that are *more threatened than leaderTo* are penalized (directional gradient).
    // This gives support a sense of where danger comes from even outside hard r3.
    const _cm = getCombatMatrix(runtime, room.name);
    const _leaderToCost = _cm ? readMatrixCost(_cm, leaderTo.x, leaderTo.y) : 0;
    const _threatWeight = Number.isFinite(formation && formation.supportThreatWeight)
        ? formation.supportThreatWeight
        : 4; // default: mild
    const _gradientWeight = Number.isFinite(formation && formation.supportThreatGradientWeight)
        ? formation.supportThreatGradientWeight
        : 2; // default: mild

    function hardReject(pos) {
        if (!pos) return true;
        // one-tick step only (or hold)
        if (support.pos.getRangeTo(pos) > 1) return true;

        // cohesion relative to intended leaderTo
        if (pos.roomName !== leaderTo.roomName) return true;
        if (pos.getRangeTo(leaderTo) > rangeMax) return true;

        // border hygiene: never end on exits in cohesive mode
        if (isExitTile(pos)) return true;

        // passability, with trail special-case
        const isTrail = isSamePos(pos, leader.pos);
        if (!isTrail) {
            if (!isPassableForSupport(room, pos, leader, support, movePlan)) return true;
        } else {
            // allow stepping into leader current tile (vacated this tick) as glue
            const terrain = room.getTerrain().get(pos.x, pos.y);
            if (terrain === TERRAIN_MASK_WALL) return true;
            const structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
            if (structures && structures.some(s => !isWalkableStructure(s))) return true;
            // Only allow trail if leader is actually vacating this tile this tick.
            if (!allowedByVacating(movePlan, pos)) return true;
        }

        // safety hard filter (combat-hardened support)
        const hardThreshold =
            Number.isFinite(formation && formation.supportHardThreatThreshold)
                ? formation.supportHardThreatThreshold
                : 40;

        if (isUnsafeForSupport(room, pos, runtime, { allowExit: false, hardThreshold })) return true;

        // ✅ Relative hardening: reject tiles that are significantly more threatened than leaderTo.
        // This makes support "hug the safer flank" when your aura (r4..r7) is present.
        const deltaHard =
            Number.isFinite(formation && formation.supportThreatDeltaHard)
                ? formation.supportThreatDeltaHard
                : 25; // tune 15..40

        if (_cm && deltaHard > 0) {
            const tileCost = readMatrixCost(_cm, pos.x, pos.y);
            const delta = tileCost - _leaderToCost;
            if (delta > deltaHard) return true;
        }

        return false;
    }

    function score(pos, pri) {
        let s = 0;

        // Terrain penalty (prevents swamp dragging leader)
        const terrain = room.getTerrain().get(pos.x, pos.y);
        const swampPenalty =
            Number.isFinite(formation && formation.supportSwampPenalty)
                ? formation.supportSwampPenalty
                : 25; // tune 15–40

        if (terrain === TERRAIN_MASK_SWAMP) {
            s += swampPenalty;
        }

        // Threat gradient preference: keep support on lower-pressure tiles.
        // This is "soft" (works even when tile is not lethal) and helps orientation.
        if (_cm && _threatWeight > 0) {
            const tileCost = readMatrixCost(_cm, pos.x, pos.y);
            if (tileCost > 0) {
                s += tileCost * _threatWeight;
                // Directional feel: penalize stepping to a tile that is more threatened than leaderTo.
                const delta = tileCost - _leaderToCost;
                if (delta > 0 && _gradientWeight > 0) s += delta * _gradientWeight;
            }
        }

        const dIntended = pos.getRangeTo(leaderTo);
        const dCurrent = pos.getRangeTo(leader.pos);

        // Prefer sticking close to intended move
        s += dIntended * 20;

        // Magnet to preferred adjacency
        if (dIntended > preferred) s += (dIntended - preferred) * 120;
        // Trail is fallback glue, not default — unless travel mode explicitly prefers it.
        const isTrail = isSamePos(pos, leader.pos);
        if (isTrail) {
            const preferTrail = formation && formation.travelSupportMode === 'trail';
            s += preferTrail ? -120 : 80;
        }

        // Priority layer (candidate generation order)
        s += (Number.isFinite(pri) ? pri : 0);

        return s;
    }

    // Rule 7: Candidate generation priority
    // 1) Adjacent to leaderIntendedTo
    const adjIntended = getAdjacentTo(leaderTo);
    for (let i = 0; i < adjIntended.length; i++) {
        const p = adjIntended[i];
        if (hardReject(p)) continue;
        candidates.push({ pos: p, score: score(p, 0 + i) });
    }

    // 2) Adjacent to leaderCurrentPos
    const adjCurrent = getAdjacentTo(leader.pos);
    for (let i = 0; i < adjCurrent.length; i++) {
        const p = adjCurrent[i];
        if (hardReject(p)) continue;
        candidates.push({ pos: p, score: score(p, 20 + i) });
    }

    // 3) leaderCurrentPos (trail tile) - only if adjacent now
    if (support.pos.getRangeTo(leader.pos) === 1) {
        const p = leader.pos;
        if (!hardReject(p)) {
            const preferTrail = formation && formation.travelSupportMode === 'trail';
            // If we're explicitly in trail mode (travel / non-combat), try trail early.
            candidates.push({ pos: p, score: score(p, preferTrail ? -10 : 10) });
        }
    }

    // 4) HOLD (only if staying is safe)
    if (!isUnsafeForSupport(room, support.pos, runtime, { allowExit: false })) {
        // HOLD is represented by current pos
        candidates.push({ pos: support.pos, score: score(support.pos, 80) });
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.score - b.score);

    // Return best
    return candidates[0].pos;
}

function buildStepResult(leader, support, leaderTo, supportTo) {
    const leaderDir = leader && leaderTo ? getDirBetween(leader.pos, leaderTo) : null;
    const supportDir = support && supportTo ? getDirBetween(support.pos, supportTo) : null;
    return {
        leaderDir: leaderDir || null,
        supportDir: supportDir || null,
        leaderTo: leaderTo || null,
        supportTo: supportTo || null
    };
}

function shouldHoldForFatigue(leader, support) {
    if (leader && leader.fatigue > 0) return true;
    if (support && support.fatigue > 0) return true;
    return false;
}

function isBlockedByStructureAt(room, pos) {
    if (!room || !pos) return false;
    const structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
    if (!structures || structures.length === 0) return false;
    for (const s of structures) {
        if (s.structureType === STRUCTURE_WALL) return true;
        if (s.structureType === STRUCTURE_RAMPART) {
            if (!s.my && !s.isPublic) return true;
        }
    }
    return false;
}

function isValidExitTile(room, pos) {
    if (!room || !pos) return false;
    if (pos.roomName !== room.name) return false;
    if (!isExitTile(pos)) return false;
    const terrain = room.getTerrain().get(pos.x, pos.y);
    if (terrain === TERRAIN_MASK_WALL) return false;
    if (isBlockedByStructureAt(room, pos)) return false;
    return true;
}

function pickExitTileByProjection(room, toRoomName, referencePos) {
    if (!room || !toRoomName) return null;
    const exitDir = getExitDir(room.name, toRoomName);
    if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) return null;
    const exits = room.find(exitDir);
    if (!exits || exits.length === 0) return null;

    // If referencePos is in another room (common in split-regroup), do NOT fall back to (25,25).
    // Instead, project the reference coordinate onto the relevant border so we pick an aligned exit
    // and avoid "walking the full length of the border".
    let ref;
    if (referencePos) {
        const rx = referencePos.x;
        const ry = referencePos.y;
        // clamp helper
        const cx = Math.max(0, Math.min(49, rx));
        const cy = Math.max(0, Math.min(49, ry));
        // FIND_EXIT_* are 1/3/5/7 in Screeps
        if (exitDir === FIND_EXIT_LEFT)   ref = new RoomPosition(0,  cy, room.name);
        else if (exitDir === FIND_EXIT_RIGHT)  ref = new RoomPosition(49, cy, room.name);
        else if (exitDir === FIND_EXIT_TOP)    ref = new RoomPosition(cx, 0,  room.name);
        else if (exitDir === FIND_EXIT_BOTTOM) ref = new RoomPosition(cx, 49, room.name);
        else ref = new RoomPosition(25, 25, room.name);
    } else {
        ref = new RoomPosition(25, 25, room.name);
    }

    // Prefer valid exit tiles (not boxed by walls/ramparts) if we have vision.
    const candidates = [];
    const fallback = [];
    for (const pos of exits) {
        const p = new RoomPosition(pos.x, pos.y, room.name);
        if (isValidExitTile(room, p)) candidates.push(p);
        else fallback.push(p);
    }
    const list = candidates.length > 0 ? candidates : fallback;

    let best = list[0];
    let bestRange = Infinity;
    for (const pos of list) {
        const range = ref.getRangeTo(pos);
        if (range < bestRange) {
            bestRange = range;
            best = pos;
        }
    }
    return best ? new RoomPosition(best.x, best.y, room.name) : null;
}

function pickExitTileByPF(room, toRoomName, fromPos, targetPos, movement, runtime, ignoreCreepIds) {
    if (!room || !toRoomName || !fromPos || !targetPos) return null;

    // Use PF to compute a cross-room path, then extract the last step in THIS room before the room changes.
    // This gives a "valid" exit lane that PF prefers, without changing your border-crossing handshake.
    const goal = { pos: targetPos, range: 1, key: `exitpf:${targetPos.roomName}:${targetPos.x}:${targetPos.y}` };

    const extra = {
        considerCreeps: true,
        ignoreCreepIds: ignoreCreepIds || null,
        // Important: do NOT penalize borders here, because we *want* PF to walk onto the edge when needed.
        avoidBorders: false,
        maxRooms: 2
    };

    const result = computePathSteps(fromPos, goal, movement || {}, runtime || null, extra);
    if (!result || !result.pf || !result.pf.path || result.pf.path.length === 0) return null;

    const path = result.pf.path;
    const fromRoomName = room.name;

    for (let i = 0; i < path.length; i++) {
        const step = path[i];
        if (step.roomName !== fromRoomName) {
            const prev = i > 0 ? path[i - 1] : null;
            if (!prev || prev.roomName !== fromRoomName) return null;
            const exitPos = new RoomPosition(prev.x, prev.y, fromRoomName);
            if (!isExitTile(exitPos)) return null;
            if (!isValidExitTile(room, exitPos)) return null;
            return exitPos;
        }
    }

    // If we never left the room in the path (PF incomplete / maxRooms / etc), fall back.
    return null;
}

function pickExitTile(room, toRoomName, referencePos, opts) {
    if (!room || !toRoomName) return null;

    const options = opts || {};
    const fromPos = options.fromPos || null;
    const targetPos = options.targetPos || null;
    const movement = options.movement || null;
    const runtime = options.runtime || null;
    const ignoreCreepIds = options.ignoreCreepIds || null;

    // 1) Prefer PF-derived exit lanes when we have enough info.
    if (fromPos && targetPos) {
        const pfExit = pickExitTileByPF(room, toRoomName, fromPos, targetPos, movement, runtime, ignoreCreepIds);
        if (pfExit) return pfExit;
    }

    // 2) Fallback: projection scoring (fast, deterministic)
    return pickExitTileByProjection(room, toRoomName, referencePos);
}

function serializePos(pos) {
    if (!pos) return null;
    return { x: pos.x, y: pos.y, roomName: pos.roomName };
}

function deserializePos(pos) {
    if (!pos) return null;
    return new RoomPosition(pos.x, pos.y, pos.roomName);
}

function getDuoMemory(memoryKey) {
    if (!memoryKey) return null;

    if (!Memory.military) Memory.military = {};
    if (!Memory.military.runtime) Memory.military.runtime = {};

    if (!Memory.military.runtime[memoryKey]) {
        Memory.military.runtime[memoryKey] = {};
    }

    const runtimeMem = Memory.military.runtime[memoryKey];

    if (!runtimeMem.duoPlanner) {
        runtimeMem.duoPlanner = {};
    }

    return runtimeMem.duoPlanner;
}

function buildGoalKey(goalPos, goalType, goalRange) {
    return `${goalPos.roomName}:${goalPos.x}:${goalPos.y}:${goalType}:${goalRange}`;
}

function getPathState(memory, purpose) {
    if (!memory || !purpose) return null;
    if (!memory.paths) memory.paths = {};
    if (!memory.paths[purpose]) {
        memory.paths[purpose] = {
            key: null,
            steps: [],
            idx: 0,
            lastRecalc: 0,
            stalledTicks: 0,
            lastToKey: null
        };
    }
    return memory.paths[purpose];
}

function peekNextDir(ps) {
    if (!ps || !ps.steps || ps.idx >= ps.steps.length) return null;
    return ps.steps[ps.idx];
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

function tickProgress(ps, currentPosKey, movement) {
    if (!ps) return { advanced: false, stalled: false };
    const advanced = advanceIfProgress(ps, currentPosKey);
    let stalled = false;
    // Only count a stall if we were expecting a move last tick.
    if (!advanced && ps.lastToKey) {
        stalled = true;
        markStall(ps);
        const threshold = Number.isFinite(movement && movement.stallRepathTicks) ? movement.stallRepathTicks : 2;
        if ((ps.stalledTicks || 0) >= threshold) {
            ps.steps = [];
            ps.idx = 0;
            ps.lastToKey = null;
            ps.stalledTicks = 0;
        }
    }
    return { advanced, stalled };
}


function invalidatePath(memory, purpose) {
    const ps = getPathState(memory, purpose);
    if (!ps) return;
    ps.steps = [];
    ps.idx = 0;
    ps.lastToKey = null;
    ps.stalledTicks = 0;
    ps.lastRecalc = Game.time;
}

// =========================================
// Temporary PF blocks (traffic / stall busting)
// =========================================

function getInject(memory) {
    if (!memory) return null;
    if (!memory.inject || typeof memory.inject !== 'object') memory.inject = { byRoom: {} };
    if (!memory.inject.byRoom) memory.inject.byRoom = {};
    return memory.inject;
}

function addTempBlock(memory, roomName, pos, ttlTicks = 5, cost = 255) {
    if (!memory || !roomName || !pos) return;
    const inject = getInject(memory);
    if (!inject) return;
    const r = inject.byRoom[roomName] || (inject.byRoom[roomName] = {});
    const key = `${pos.x}:${pos.y}`;
    const until = Game.time + (Number.isFinite(ttlTicks) ? ttlTicks : 5);
    const prev = r[key];
    r[key] = {
        until: prev ? Math.max(prev.until || 0, until) : until,
        cost: Number.isFinite(cost) ? cost : 255
    };
}

function purgeTempBlocks(memory) {
    const inject = getInject(memory);
    if (!inject) return;
    for (const roomName in inject.byRoom) {
        const r = inject.byRoom[roomName];
        if (!r) continue;
        for (const k in r) {
            if (!r[k] || (r[k].until || 0) <= Game.time) delete r[k];
        }
        if (Object.keys(r).length === 0) delete inject.byRoom[roomName];
    }
}

function parseToKey(key) {
    // "room:x:y" -> { roomName, x, y }
    if (!key || typeof key !== 'string') return null;
    const parts = key.split(':');
    if (parts.length !== 3) return null;
    const roomName = parts[0];
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    if (!roomName || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { roomName, x, y };
}

function tickProgressAndInject(memory, purpose, creepPos, movement) {
    if (!memory || !purpose || !creepPos) return;
    const ps = getPathState(memory, purpose);
    if (!ps) return;

    // capture expected tile BEFORE tickProgress may clear it
    const expectedKey = ps.lastToKey ? String(ps.lastToKey) : null;
    const prog = tickProgress(ps, posKey(creepPos), movement);

    // On stall (we expected a move but didn't advance):
    // - inject a short-lived hard block on the expected next tile (traffic busting)
    // - invalidate the cached path so we recompute immediately this tick
    if (prog && prog.stalled && expectedKey) {
        const p = parseToKey(expectedKey);
        if (p && p.roomName) {
            addTempBlock(memory, p.roomName, { x: p.x, y: p.y }, 5, 255);
            invalidatePath(memory, purpose);
        }
    }
}

function buildRoomCallback(runtimeCallback, preferRoads, opts = {}) {
    const {
        // Treat creeps as blocked? (recommended for regroup)
        considerCreeps = true,

        // A Set of creep ids that should NOT be treated as obstacles
        ignoreCreepIds = null, // e.g. new Set([leader.id, support.id])

        // A Set of packed positions ("room:x:y") that are expected to be vacated this tick
        // so PF is allowed to step into them (optional).
        vacatingPosKeys = null,

        // Make borders more expensive to reduce exit-tile weirdness during regroup
        avoidBorders = true,
        borderCost = 10, // cost added on x==0/49 or y==0/49

        // Penalties / preferences
        plainCost = 2,
        swampCost = 10,
        roadCost = 1,
        creepCost = 50,
        portalCost = 1,

        // If true, we’ll compute a full matrix even when runtimeCallback returns undefined.
        // If false, we only return a matrix when needed (preferRoads/considerCreeps/avoidBorders).
        alwaysBuild = false,

        // Temporary injected blocks: memory.inject (shape: { byRoom: { [roomName]: { "x:y": {until,cost} } } })
        inject = null,
    } = opts;

    function keyOf(pos) {
        // pos can be RoomPosition or {x,y,roomName}
        if (!pos) return null;
        const roomName = pos.roomName || (pos.room && pos.room.name);
        if (!roomName) return null;
        return `${roomName}:${pos.x}:${pos.y}`;
    }

    return function(roomName) {
        // 1) Start from runtimeCallback if provided
        let base = undefined;
        if (runtimeCallback) {
            const result = runtimeCallback(roomName);
            if (result === false) return false;
            if (result) base = result;
        }

        const room = Game.rooms[roomName];
        const needMatrix =
            alwaysBuild ||
            preferRoads ||
            considerCreeps ||
            avoidBorders ||
            !base; // if no base, we need to create one when any feature needs it

        if (!needMatrix) return base; // could be undefined (PF will use defaults)

        // 2) Create or clone a matrix
        // If base is provided, we should clone it so we don't mutate caller's matrix.
        let costs;
        if (base) {
            costs = base.clone();
        } else {
            costs = new PathFinder.CostMatrix();
        }

        if (!room) {
            // no vision, can't add obstacles/roads/creeps
            // but still return matrix if we created/cloned one
            return costs;
        }

        // 3) Encode terrain baseline (plain/swamp) only if we created a fresh matrix.
        // If base came from runtimeCallback, we assume it already has terrain prefs.
        const terrain = room.getTerrain();

        // ✅ Always enforce natural walls, even if runtimeCallback provided a base matrix.
        // Some callers return matrices without terrain baked in; without this, PF can step into walls.
        if (base) {
            for (let y = 0; y < 50; y++) {
                for (let x = 0; x < 50; x++) {
                    if (terrain.get(x, y) === TERRAIN_MASK_WALL) costs.set(x, y, 255);
                }
            }
        }

        if (!base) {
            for (let y = 0; y < 50; y++) {
                for (let x = 0; x < 50; x++) {
                    const t = terrain.get(x, y);
                    if (t === TERRAIN_MASK_WALL) {
                        costs.set(x, y, 255);
                    } else if (t === TERRAIN_MASK_SWAMP) {
                        costs.set(x, y, swampCost);
                    } else {
                        costs.set(x, y, plainCost);
                    }
                }
            }
        } else {
            // If a caller provided a base matrix but left "default" tiles as 0,
            // we still want reasonable plain/swamp costs so PF doesn't happily cut through swamps.
            for (let y = 0; y < 50; y++) {
                for (let x = 0; x < 50; x++) {
                    if (costs.get(x, y) !== 0) continue;
                    const t = terrain.get(x, y);
                    if (t === TERRAIN_MASK_WALL) {
                        costs.set(x, y, 255);
                    } else if (t === TERRAIN_MASK_SWAMP) {
                        costs.set(x, y, swampCost);
                    } else {
                        costs.set(x, y, plainCost);
                    }
                }
            }
        }

        // 4) Static structures & sites
        // - Roads: prefer (set low cost)
        // - Containers: passable (don’t block)
        // - Ramparts: block if not yours/public (common safe rule)
        // - Everything else: block (255)
        const structs = room.find(FIND_STRUCTURES);
        for (const s of structs) {
            const x = s.pos.x, y = s.pos.y;

            if (s.structureType === STRUCTURE_ROAD) {
                if (preferRoads) {
                    const cur = costs.get(x, y);
                    // ✅ Do NOT overwrite higher (threat) costs
                    // Only make roads cheaper when the tile is 'baseline' (not already a threat overlay).
                    // Threat overlays (combat matrix) are typically >= 20. Do NOT erase them.
                    if (cur !== 255 && (cur === 0 || cur < 20) && cur > roadCost) costs.set(x, y, roadCost);
                }
                continue;
            }

            if (s.structureType === STRUCTURE_CONTAINER) {
                // passable; leave terrain/default
                continue;
            }

            if (s.structureType === STRUCTURE_RAMPART) {
                // Friendly ramparts are passable; hostile ramparts block (safe default)
                // public ramparts can be passable too (optional logic)
                if (s.my) continue;
                if (s.isPublic) continue;
                costs.set(x, y, 255);
                continue;
            }

            // Portals
            if (s.structureType === STRUCTURE_PORTAL) {
                costs.set(x, y, portalCost);
                continue;
            }

            // Most other structures block movement
            costs.set(x, y, 255);
        }

        const sites = room.find(FIND_CONSTRUCTION_SITES);
        for (const cs of sites) {
            const x = cs.pos.x, y = cs.pos.y;

            // roads/containers/ramparts are OK; most other sites block
            if (cs.structureType === STRUCTURE_ROAD) {
                if (preferRoads) {
                    const cur = costs.get(x, y);
                    // Same rule as structures: don't erase combat/threat overlay values.
                    if (cur !== 255 && (cur === 0 || cur < 20) && cur > roadCost) costs.set(x, y, roadCost);
                }
                continue;
            }
            if (cs.structureType === STRUCTURE_CONTAINER) continue;
            if (cs.structureType === STRUCTURE_RAMPART) continue;

            costs.set(x, y, 255);
        }

        // 5) Creeps as obstacles (dynamic)
        if (considerCreeps) {
            const creeps = room.find(FIND_CREEPS);
            for (const c of creeps) {
                if (ignoreCreepIds && ignoreCreepIds.has(c.id)) continue;

                const k = keyOf(c.pos);
                if (vacatingPosKeys && k && vacatingPosKeys.has(k)) {
                    // expected to be vacated this tick; don't block
                    continue;
                }

                // Treat creeps as high-cost obstacles (not hard walls).
                // This avoids long stalls in 1-tile chokes (e.g., miners at sources).
                const cx = c.pos.x, cy = c.pos.y;
                const cur = costs.get(cx, cy);
                if (cur !== 255 && cur < creepCost) costs.set(cx, cy, creepCost);
            }
        }

        // 6) Avoid borders / exits (helps prevent border oscillation / accidental crossings)
        if (avoidBorders) {
            for (let i = 0; i < 50; i++) {
                // x borders
                if (costs.get(0, i) < 255) costs.set(0, i, Math.min(254, costs.get(0, i) + borderCost));
                if (costs.get(49, i) < 255) costs.set(49, i, Math.min(254, costs.get(49, i) + borderCost));
                // y borders
                if (costs.get(i, 0) < 255) costs.set(i, 0, Math.min(254, costs.get(i, 0) + borderCost));
                if (costs.get(i, 49) < 255) costs.set(i, 49, Math.min(254, costs.get(i, 49) + borderCost));
            }
        }

        // 7) Apply temporary injected blocks (hard override)
        const inj = inject && inject.byRoom ? inject.byRoom[roomName] : null;
        if (inj && Object.keys(inj).length > 0) {
            for (const key in inj) {
                const rec = inj[key];
                if (!rec || (rec.until || 0) <= Game.time) continue;
                const parts = String(key).split(':');
                if (parts.length !== 2) continue;
                const x = Number(parts[0]);
                const y = Number(parts[1]);
                if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                const c = Number.isFinite(rec.cost) ? rec.cost : 255;
                const cur = costs.get(x, y);
                costs.set(x, y, Math.max(cur, c));
            }
        }

        return costs;
    };
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

function computePathSteps(fromPos, goal, movement, runtime, extra = {}) {
    if (!fromPos || !goal || !goal.pos) return { steps: [], incomplete: true, pf: null };
    const roomCallback = buildRoomCallback(runtime && runtime.roomCallback, movement.preferRoads, extra);
    const pf = PathFinder.search(
        fromPos,
        { pos: goal.pos, range: goal.range },
        {
            maxRooms: Number.isFinite(extra.maxRooms) ? extra.maxRooms : 1,
            roomCallback
        }
    );
    if (!pf || !pf.path || pf.path.length === 0) {
        return { steps: [], incomplete: pf ? pf.incomplete : true, pf };
    }
    const steps = packDirections(pf.path, fromPos);
    return { steps, incomplete: !!pf.incomplete, pf };
}

function ensurePath(memory, purpose, fromPos, goal, movement, runtime, extra, forceRecalc = false) {
    const ps = getPathState(memory, purpose);
    if (!ps || !fromPos || !goal || !goal.pos) return ps;
    const key = goal.key;
    const pathReuseTicks = Number.isFinite(movement.pathReuseTicks) ? movement.pathReuseTicks : 25;
    const reuseOk =
        !forceRecalc &&
        ps.key === key &&
        ps.steps.length > 0 &&
        ps.idx < ps.steps.length &&
        (Game.time - ps.lastRecalc) <= pathReuseTicks;
    if (reuseOk) return ps;

    const result = computePathSteps(fromPos, goal, movement, runtime, extra);
    ps.key = key;
    ps.steps = result.steps;
    ps.idx = 0;
    ps.lastRecalc = Game.time;
    ps.stalledTicks = 0;
    ps.lastToKey = null;
    return ps;
}


// =========================================
// PF single-step helpers (no 8-tile greedy)
// =========================================
function getPfNextDir(memory, purpose, fromPos, goal, movement, runtime, extra, forceRecalc = false) {
    // Returns { ps, dir } where ps may be null if no memory.
    if (!fromPos || !goal || !goal.pos) return { ps: null, dir: null };
    let ps = null;
    let dir = null;

    if (memory) {
        ps = ensurePath(memory, purpose, fromPos, goal, movement, runtime, extra, forceRecalc);
        dir = peekNextDir(ps);
    } else {
        const result = computePathSteps(fromPos, goal, movement, runtime, extra);
        dir = result.steps && result.steps.length > 0 ? result.steps[0] : null;
    }

    return { ps, dir };
}

function pfStepToward(memory, purpose, creep, goalPos, range, movement, runtime, extra, allowedExitPos, forceRecalc = false) {
    // Returns { dir, to } or { dir:null, to:null }.
    if (!creep || !creep.pos || !goalPos) return { dir: null, to: null, ps: null };
    const goal = {
        pos: goalPos,
        range: Number.isFinite(range) ? range : 1,
        key: `${purpose}:${goalPos.roomName}:${goalPos.x}:${goalPos.y}:r${Number.isFinite(range) ? range : 1}`
    };

    const { ps, dir } = getPfNextDir(memory, purpose, creep.pos, goal, movement, runtime, extra, forceRecalc);
    if (!dir) return { dir: null, to: null, ps };

    const to = clampRoomPos(dirToPos(creep.pos, dir));
    if (!to) return { dir: null, to: null, ps };

    // Split-room rule: never "end" on random border tiles; only allow the designated exit tile.
    // IMPORTANT: this must NOT apply to normal travel, otherwise PF will refuse to step onto exits
    // and the duo will get stuck at x/y==1 next to the border.
    if (allowedExitPos != null && isForbiddenSplitEnd(to, allowedExitPos)) {
        return { dir: null, to: null, ps };
    }

    if (ps) ps.lastToKey = posKey(to);

    return { dir, to, ps };
}

function isExitTile(pos) {
  return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
}

function nearBorder(pos, margin) {
    if (!pos) return false;
    const m = Number.isFinite(margin) ? margin : 1;
    return pos.x <= m || pos.x >= (49 - m) || pos.y <= m || pos.y >= (49 - m);
}

function nearEdge(pos, edge, margin) {
    if (!pos) return false;
    const m = Number.isFinite(margin) ? margin : 1;
    if (edge === 'x0')  return pos.x <= m;
    if (edge === 'x49') return pos.x >= (49 - m);
    if (edge === 'y0')  return pos.y <= m;
    if (edge === 'y49') return pos.y >= (49 - m);
    return nearBorder(pos, m);
}

// Choose a dir that moves 1 tile inward (off the edge).
function inwardDirs(pos) {
    const dirs = [];
    if (pos.x === 0)  dirs.push(3, 2, 4);      // RIGHT, TOP_RIGHT, BOTTOM_RIGHT
    if (pos.x === 49) dirs.push(7, 8, 6);      // LEFT,  TOP_LEFT,  BOTTOM_LEFT
    if (pos.y === 0)  dirs.push(5, 4, 6);      // BOTTOM, BOTTOM_RIGHT, BOTTOM_LEFT
    if (pos.y === 49) dirs.push(1, 2, 8);      // TOP, TOP_RIGHT, TOP_LEFT
    // De-dup while preserving order
    return [...new Set(dirs)];
}

function isLeaderDirPassable(leader, support, dir, movePlan) {
    const next = dirToPos(leader.pos, dir);
    if (!next) return false;
    const plan = movePlan || buildMovePlan(leader, support, next, support ? support.pos : null);
    return isPassableForLeader(leader.room, next, leader, support, plan);
}

function isSupportDirPassable(leader, support, dir, movePlan) {
    const next = dirToPos(support.pos, dir);
    if (!next) return false;
    const plan = movePlan || buildMovePlan(leader, support, leader ? leader.pos : null, next);
    return isPassableForSupport(support.room, next, leader, support, plan);
}

function applyBorderHygieneToStep(step, leader, support) {
    if (!step || !leader || !support) return step;

    // Where would each creep END this tick (in the current room)?
    const leaderEnd = step.leaderTo || leader.pos;
    const supportEnd = step.supportTo || support.pos;

    // If the step is an intentional border cross this tick, allow ending on the edge.
    const leaderCrossing = isCrossIntent(leader, step, 'leader');
    const supportCrossing = isCrossIntent(support, step, 'support');

    const leaderEndsOnExit = isExitTile(leaderEnd);
    const supportEndsOnExit = isExitTile(supportEnd);

    // ✅ Handshake exception:
    // If leader is intentionally crossing this tick AND support is intentionally docking onto the
    // same exit tile (common in border-handshake / pre-cross), do NOT nudge support inward.
    // Otherwise, hygiene can break the handshake and cause room-split ping-pong.
    const supportDockingForHandshake =
        leaderCrossing &&
        leaderEndsOnExit &&
        supportEndsOnExit &&
        isSamePos(supportEnd, leaderEnd);

    // If they would end on an exit tile without actually crossing, we must push inward.
    const needFixLeader = leaderEndsOnExit && !leaderCrossing;
    const needFixSupport = supportEndsOnExit && !supportCrossing && !supportDockingForHandshake;

    if (!needFixLeader && !needFixSupport) return step;

    // Build a movePlan so passability respects your "claimed/vacating" same-tick rules.
    const plan = buildMovePlan(
        leader,
        support,
        step.leaderTo || leader.pos,
        step.supportTo || support.pos
    );

    // Helper: try pick an inward step for leader/support from their CURRENT position
    function nudgeLeaderInward() {
        for (const d of inwardDirs(leader.pos)) {
            const next = dirToPos(leader.pos, d);
            if (!next) continue;
            if (isExitTile(next)) continue;
            if (!isLeaderDirPassable(leader, support, d, plan)) continue;

            step.leaderDir = d;
            step.leaderTo = next;

            // update plan so support checks see leader vacating/claiming correctly
            plan.intent.leader.to = next;
            plan.vacating.add(posKey(leader.pos));
            plan.claimed.add(posKey(next));
            return true;
        }
        return false;
    }

    function nudgeSupportInward() {
        for (const d of inwardDirs(support.pos)) {
            const next = dirToPos(support.pos, d);
            if (!next) continue;
            if (isExitTile(next)) continue;
            if (!isSupportDirPassable(leader, support, d, plan)) continue;

            step.supportDir = d;
            step.supportTo = next;

            plan.intent.support.to = next;
            plan.vacating.add(posKey(support.pos));
            plan.claimed.add(posKey(next));
            return true;
        }
        return false;
    }

    // Order matters: if both need fixing, push leader first so support can react to updated plan
    if (needFixLeader) nudgeLeaderInward();
    if (needFixSupport) nudgeSupportInward();

    return step;
}

function isCrossIntent(creep, step, which) {
    // crossing is expressed as: to == currentPos AND dir == getBorderCrossDir(currentPos)
    // (your code uses leaderTo: leader.pos, leaderDir: crossDir)
    if (!creep || !step) return false;
    const dir = which === 'leader' ? step.leaderDir : step.supportDir;
    const to  = which === 'leader' ? step.leaderTo  : step.supportTo;
    if (!dir) return false;
    if (!to || !isSamePos(to, creep.pos)) return false;
    const crossDir = getBorderCrossDir(creep.pos);
    return crossDir != null && dir === crossDir;
}

function isForbiddenSplitEnd(pos, allowedExitPos) {
    // In split-room regrouping:
    // - forbid ending on random border tiles (prevents pingpong / border-walk)
    // - BUT allow ending on the *designated* exit tile so we can stage and cross next tick
    if (!pos) return true;
    if (!isExitTile(pos)) return false;
    if (!allowedExitPos) return true;
    return !isSamePos(pos, allowedExitPos);
}

function exitDirToEdgeAndCross(exitDir) {
    // exitDir is one of FIND_EXIT_TOP/RIGHT/BOTTOM/LEFT
    if (exitDir === FIND_EXIT_TOP)    return { edge: 'y0',  crossDir: 1 }; // TOP
    if (exitDir === FIND_EXIT_RIGHT)  return { edge: 'x49', crossDir: 3 }; // RIGHT
    if (exitDir === FIND_EXIT_BOTTOM) return { edge: 'y49', crossDir: 5 }; // BOTTOM
    if (exitDir === FIND_EXIT_LEFT)   return { edge: 'x0',  crossDir: 7 }; // LEFT
    return null;
}

// Prefer Game.map.describeExits() over room.findExitTo() when determining the *direction* to an adjacent room.
// This prevents rare but nasty "cross -> immediate cross back" ping-pongs when the handshake logic derives
// the wrong edge/crossDir from a multi-room final target or stale cache.
function getExitDir(fromRoomName, toRoomName) {
    if (!fromRoomName || !toRoomName) return ERR_INVALID_ARGS;
    if (fromRoomName === toRoomName) return ERR_INVALID_ARGS;

    const exits = Game.map.describeExits(fromRoomName);
    if (!exits) return ERR_NO_PATH;

    for (const d in exits) {
        if (exits[d] === toRoomName) return Number(d);
    }
    return ERR_NO_PATH;
}

// For multi-room travel, border-handshake must stage/cross toward the *next hop* (adjacent room),
// not the final destination which may be many rooms away.
function getNextHopRoomName(fromRoomName, finalRoomName) {
    if (!fromRoomName || !finalRoomName) return null;
    if (fromRoomName === finalRoomName) return finalRoomName;
    const route = Game.map.findRoute(fromRoomName, finalRoomName);
    if (route === ERR_NO_PATH || !route || route.length === 0) return null;
    return route[0] && route[0].room ? route[0].room : null;
}

function posOnEdge(pos, edge) {
    if (!pos) return false;
    if (edge === 'x0')  return pos.x === 0;
    if (edge === 'x49') return pos.x === 49;
    if (edge === 'y0')  return pos.y === 0;
    if (edge === 'y49') return pos.y === 49;
    return false;
}

function sameEdge(a, b) {
    if (!a || !b) return false;
    if (!isExitTile(a) || !isExitTile(b)) return false;
    // share the same border line
    if (a.x === 0 && b.x === 0) return true;
    if (a.x === 49 && b.x === 49) return true;
    if (a.y === 0 && b.y === 0) return true;
    if (a.y === 49 && b.y === 49) return true;
    return false;
}

function adjacentExitCandidatesOnSameEdge(exitPos) {
    if (!exitPos || !isExitTile(exitPos)) return [];
    const out = [];
    const adj = getAdjacentTo(exitPos);
    for (const p of adj) {
        if (!p) continue;
        if (!isExitTile(p)) continue;
        if (!sameEdge(exitPos, p)) continue;
        out.push(p);
    }
    return out;
}


function planSplitToGoalRoom(leader, support, goalPos, memory, movement, runtime) {
    if (!leader || !support || !goalPos) return null;

    const leaderRoom = leader.room;
    const supportRoom = support.room;
    if (!leaderRoom || !supportRoom) return null;

    const goalRoomName = goalPos.roomName;
    const leaderInGoalRoom = leaderRoom.name === goalRoomName;
    const supportInGoalRoom = supportRoom.name === goalRoomName;

    const extra = {
        considerCreeps: true,
        ignoreCreepIds: buildIgnoreSet(leader, support),
        avoidBorders: true,
        maxRooms: 1,
        inject: memory ? getInject(memory) : null
    };

    // If one is already in the goal room, DO NOT pull it out to meet the other.
    // Instead: keep it moving toward goalPos (or holding), while the other crosses into goal room.
    if (leaderInGoalRoom && !supportInGoalRoom) {
        const supportExit = pickExitTile(supportRoom, goalRoomName, goalPos, { fromPos: support.pos, targetPos: goalPos, movement, runtime, ignoreCreepIds: buildIgnoreSet(leader, support) });
        if (!supportExit) return null;

        const leaderStep = pfStepToward(memory, 'split_goal_leader', leader, goalPos, 1, movement, runtime, extra, null);
        const supportStep = pfStepToward(memory, 'split_goal_support', support, supportExit, 0, movement, runtime, extra, supportExit);

        return {
            leaderDir: leaderStep.dir,
            leaderTo: leaderStep.to || leader.pos,
            supportDir: supportStep.dir,
            supportTo: supportStep.to || support.pos
        };
    }

    if (supportInGoalRoom && !leaderInGoalRoom) {
        const leaderExit = pickExitTile(leaderRoom, goalRoomName, goalPos, { fromPos: leader.pos, targetPos: goalPos, movement, runtime, ignoreCreepIds: buildIgnoreSet(leader, support) });
        if (!leaderExit) return null;

        const supportStep = pfStepToward(memory, 'split_goal_support', support, goalPos, 1, movement, runtime, extra, null);
        const leaderStep = pfStepToward(memory, 'split_goal_leader', leader, leaderExit, 0, movement, runtime, extra, leaderExit);

        return {
            leaderDir: leaderStep.dir,
            leaderTo: leaderStep.to || leader.pos,
            supportDir: supportStep.dir,
            supportTo: supportStep.to || support.pos
        };
    }

    // If both are already in goal room, let normal same-room logic handle it.
    if (leaderInGoalRoom && supportInGoalRoom) return null;

    // Neither is in goal room -> fall back to "meet each other" elsewhere.
    return null;
}


function buildIgnoreSet(leader, support) {
    const set = new Set();
    if (leader && leader.id) set.add(leader.id);
    if (support && support.id) set.add(support.id);
    return set.size > 0 ? set : null;
}


function planSplitRegroup(leader, support, goalPos, memory, movement, runtime) {
    if (!leader || !support) return null;
    const leaderRoom = leader.room;
    const supportRoom = support.room;
    if (!leaderRoom || !supportRoom) return null;

    let leaderExit = null;
    let supportExit = null;

    if (memory && memory.regroupLeaderExit && memory.regroupSupportExit) {
        const cachedLeader = deserializePos(memory.regroupLeaderExit);
        const cachedSupport = deserializePos(memory.regroupSupportExit);

        // Validate cache against current rooms + visibility (constructed walls/ramparts can change).
        if (
            cachedLeader &&
            cachedSupport &&
            cachedLeader.roomName === leaderRoom.name &&
            cachedSupport.roomName === supportRoom.name &&
            isValidExitTile(leaderRoom, cachedLeader) &&
            isValidExitTile(supportRoom, cachedSupport)
        ) {
            leaderExit = cachedLeader;
            supportExit = cachedSupport;
        }
    }

    if (!leaderExit || !supportExit) {
        const leaderRef = goalPos && goalPos.roomName === leaderRoom.name ? goalPos : support.pos;
        const supportRef = goalPos && goalPos.roomName === supportRoom.name ? goalPos : leader.pos;
        leaderExit = pickExitTile(leaderRoom, supportRoom.name, leaderRef, { fromPos: leader.pos, targetPos: leaderRef, movement, runtime, ignoreCreepIds: buildIgnoreSet(leader, support) });
        supportExit = pickExitTile(supportRoom, leaderRoom.name, supportRef, { fromPos: support.pos, targetPos: supportRef, movement, runtime, ignoreCreepIds: buildIgnoreSet(leader, support) });
        if (memory) {
            memory.regroupLeaderExit = serializePos(leaderExit);
            memory.regroupSupportExit = serializePos(supportExit);
        }
    }

    if (!leaderExit || !supportExit) return null;

    const extra = {
        considerCreeps: true,
        ignoreCreepIds: buildIgnoreSet(leader, support),
        avoidBorders: true,
        maxRooms: 1,
        inject: memory ? getInject(memory) : null
    };

    const leaderOnExit = isSamePos(leader.pos, leaderExit);
    const supportOnExit = isSamePos(support.pos, supportExit);

    // If both are staged at their exits (typically split across the border),
    // commit in a leader-anchored way: leader nudges inward, support CROSSES into leader's room.
    // This prevents border stalemates and avoids ping-pong.
    if (leaderOnExit && supportOnExit) {

        // ✅ Determine which edge *should* lead from supportRoom -> leaderRoom
        const intendedExitDir = getExitDir(supportRoom.name, leaderRoom.name);
        const intent = exitDirToEdgeAndCross(intendedExitDir);
        if (!intent) return null;

        // ✅ Only cross if we're on the correct edge for that exit direction
        if (!posOnEdge(support.pos, intent.edge)) return null;

        const crossDir = intent.crossDir; // trusted, directional

        // leader must step inward this tick
        let leaderDir = null;
        let leaderTo = leader.pos;

        const plan = buildMovePlan(leader, support, leader.pos, support.pos);
        for (const d of inwardDirs(leader.pos)) {
            const next = dirToPos(leader.pos, d);
            if (!next) continue;
            if (isExitTile(next)) continue;
            if (!isLeaderDirPassable(leader, support, d, plan)) continue;
            leaderDir = d;
            leaderTo = next;
            break;
        }

        // (highly recommended) don't cross unless leader successfully nudged inward
        if (!leaderDir) return null;

        return {
            leaderDir,
            leaderTo,
            supportDir: crossDir,
            supportTo: support.pos
        };
    }

    // If one side is already staged at its exit, HOLD it there so the other can arrive.
    // The mover uses PF-to-exit (no 8-tile greedy).
    if (leaderOnExit) {
        const s = pfStepToward(memory, 'split_regroup_support', support, supportExit, 0, movement, runtime, extra, supportExit);
        return { leaderDir: null, leaderTo: leader.pos, supportDir: s.dir, supportTo: s.to || support.pos };
    }

    if (supportOnExit) {
        const l = pfStepToward(memory, 'split_regroup_leader', leader, leaderExit, 0, movement, runtime, extra, leaderExit);
        return { leaderDir: l.dir, leaderTo: l.to || leader.pos, supportDir: null, supportTo: support.pos };
    }

    const l = pfStepToward(memory, 'split_regroup_leader', leader, leaderExit, 0, movement, runtime, extra, leaderExit);
    const s = pfStepToward(memory, 'split_regroup_support', support, supportExit, 0, movement, runtime, extra, supportExit);

    return {
        leaderDir: l.dir,
        leaderTo: l.to || leader.pos,
        supportDir: s.dir,
        supportTo: s.to || support.pos
    };
}


function selectMeetPos(room, leader, support, runtime) {
    // Rule 15: leader.pos if safe for support.
    // Otherwise choose a SAFE meet tile (radius 2–4 around leader) that is reachable by BOTH.
    if (!room || !leader || !support) return leader ? leader.pos : null;

    const leaderPos = leader.pos;
    const supportPos = support.pos;

    const isSafe = (pos) => !isUnsafeForSupport(room, pos, runtime, { allowExit: false });

    // Fast path: meet at leader if support can safely dock there.
    if (isSafe(leaderPos)) return leaderPos;

    const terrain = room.getTerrain();

    function isBasicWalkable(pos) {
        if (!pos) return false;
        if (isExitTile(pos)) return false;
        const t = terrain.get(pos.x, pos.y);
        if (t === TERRAIN_MASK_WALL) return false;
        const structs = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
        if (structs && structs.some(st => !isWalkableStructure(st))) return false;
        return true;
    }

    // Lightweight reachability probe (regroup-only, bounded ops)
    function pathLen(fromPos, toPos) {
        try {
            const ret = PathFinder.search(
                fromPos,
                { pos: toPos, range: 0 },
                {
                    maxRooms: 1,
                    maxOps: 800,
                    heuristicWeight: 1.2,
                    swampCost: 10,
                    plainCost: 2,
                    roomCallback: runtime && runtime.roomCallback ? runtime.roomCallback : undefined
                }
            );
            if (ret && ret.incomplete) return Infinity;
            return (ret && ret.path) ? ret.path.length : Infinity;
        } catch (e) {
            return Infinity;
        }
    }

    // Candidate set: rings 2..4 around leader, plus a few around midpoint.
    const candidates = [];

    function pushCandidate(pos) {
        if (!pos) return;
        if (!isBasicWalkable(pos)) return;
        if (!isSafe(pos)) return;
        candidates.push(pos);
    }

    for (const r of [2, 3, 4]) {
        for (let dx = -r; dx <= r; dx++) {
            for (let dy = -r; dy <= r; dy++) {
                const cheb = Math.max(Math.abs(dx), Math.abs(dy));
                if (cheb !== r) continue;
                const x = leaderPos.x + dx;
                const y = leaderPos.y + dy;
                if (x < 1 || x > 48 || y < 1 || y > 48) continue; // keep off exits
                pushCandidate(new RoomPosition(x, y, leaderPos.roomName));
            }
        }
    }

    const mid = new RoomPosition(
        Math.max(1, Math.min(48, Math.round((leaderPos.x + supportPos.x) / 2))),
        Math.max(1, Math.min(48, Math.round((leaderPos.y + supportPos.y) / 2))),
        leaderPos.roomName
    );
    pushCandidate(mid);
    for (const a of getAdjacentTo(mid)) pushCandidate(a);

    // If no safe candidates exist, fall back to leader.pos (even if unsafe). Regroup will then HOLD / try again.
    if (candidates.length === 0) return leaderPos;

    let best = null;
    let bestScore = Infinity;

    for (const pos of candidates) {
        const l = pathLen(leaderPos, pos);
        const s = pathLen(supportPos, pos);
        if (!Number.isFinite(l) || !Number.isFinite(s) || l === Infinity || s === Infinity) continue;

        // Prefer meeting closer to leader (keeps formation centered) and with shorter combined path.
        const score = (l + s) * 10 + leaderPos.getRangeTo(pos) * 3 + supportPos.getRangeTo(pos);
        if (score < bestScore) {
            bestScore = score;
            best = pos;
        }
    }

    return best || leaderPos;
}


function planV3(request) {
    const req = request || {};
    const leader = req.leader || null;
    const support = req.support || null;
    const memoryKey = req.memoryKey || null;

    const goal = req.goal || {};
    const goalPos = toRoomPosition(goal.pos);
    const goalType = goal.type || 'RANGE';
    const goalRange = Number.isFinite(goal.range) ? goal.range : 1;

    const formation = req.formation || {};
    const cohesionRange = Number.isFinite(formation.cohesionRange) ? formation.cohesionRange : COHESION_RANGE;
    const allowSwap = formation.allowSwap !== false;

    const movement = req.movement || {};
    const allowSplit = !!movement.allowSplit;
    const usePathCache = movement.usePathCache !== false;
    const stallRepathTicks = Number.isFinite(movement.stallRepathTicks) ? movement.stallRepathTicks : 2;

    const runtime = req.runtime || null;
    const debug = !!req.debug;

    // Optional enemy reference (for shield rule). Controller can pass target.pos here.
    const enemyPos = toRoomPosition(req.enemyPos) || null;

    const cohesion = getCohesion(leader, support, cohesionRange);
    const sameRoom = cohesion.sameRoom;
    const dist = cohesion.dist;

    const memory = memoryKey ? getDuoMemory(memoryKey) : null;

    // Purge expired local PF injections (traffic blockers etc.)
    if (memory) purgeTempBlocks(memory);

    // Progress truth: advance only if actual position matched last planned-to.
    if (memory) {
        const leaderPurposes = ['travel', 'regroup_leader', 'split_goal_leader', 'split_regroup_leader', 'border_stage_leader'];
        const supportPurposes = ['regroup', 'split_goal_support', 'split_regroup_support', 'border_stage_support'];

        for (const p of leaderPurposes) tickProgressAndInject(memory, p, leader && leader.pos, movement);
        for (const p of supportPurposes) tickProgressAndInject(memory, p, support && support.pos, movement);
    }

    // Guard: missing input
    if (!leader || !support || !goalPos) {
        return {
            ok: false,
            reason: 'missing-input',
            mode: 'HOLD',
            cohesive: cohesion.cohesive,
            sameRoom,
            dist,
            step: applyBorderHygieneToStep(buildStepResult(leader, support, null, null), leader, support),
            meta: {
                goalKey: goalPos ? buildGoalKey(goalPos, goalType, goalRange) : 'missing',
                usedPath: false,
                pathIndex: 0,
                stalledTicks: 0,
                goalRange,
                goalType
            },
            debug: debug ? { reason: 'missing-input' } : undefined
        };
    }

    // Split-room protocol is sacred: keep existing split logic.
    if (!sameRoom) {
        const goalStep = planSplitToGoalRoom(leader, support, goalPos, memory, movement, runtime);
        const step = goalStep || planSplitRegroup(leader, support, goalPos, memory, movement, runtime);

        if (step) {
            return {
                ok: true,
                reason: goalStep ? 'split-to-goal-room' : 'split-regroup',
                mode: 'REGROUP',
                cohesive: false,
                sameRoom: false,
                dist,
                step: applyBorderHygieneToStep(step, leader, support),
                meta: {
                    goalKey: buildGoalKey(goalPos, goalType, goalRange),
                    usedPath: false,
                    pathIndex: 0,
                    stalledTicks: 0,
                    goalRange,
                    goalType
                }
            };
        }

        return {
            ok: false,
            reason: 'split-no-step',
            mode: 'REGROUP',
            cohesive: false,
            sameRoom: false,
            dist,
            step: applyBorderHygieneToStep(buildStepResult(leader, support, leader.pos, support.pos), leader, support),
            meta: {
                goalKey: buildGoalKey(goalPos, goalType, goalRange),
                usedPath: false,
                pathIndex: 0,
                stalledTicks: 0,
                goalRange,
                goalType
            }
        };
    }

    const room = leader.room;
    if (!room || room.name !== support.room.name) {
        return {
            ok: false,
            reason: 'no-room',
            mode: 'HOLD',
            cohesive: cohesion.cohesive,
            sameRoom: true,
            dist,
            step: applyBorderHygieneToStep(buildStepResult(leader, support, leader.pos, support.pos), leader, support),
            meta: {
                goalKey: buildGoalKey(goalPos, goalType, goalRange),
                usedPath: false,
                pathIndex: 0,
                stalledTicks: 0,
                goalRange,
                goalType
            }
        };
    }

    // Always obey fatigue: hold. Planner still runs; just returns HOLD plan.
    if (shouldHoldForFatigue(leader, support)) {
        return {
            ok: true,
            reason: 'fatigue',
            mode: 'HOLD',
            cohesive: cohesion.cohesive,
            sameRoom: true,
            dist,
            step: applyBorderHygieneToStep(buildStepResult(leader, support, leader.pos, support.pos), leader, support),
            meta: {
                goalKey: buildGoalKey(goalPos, goalType, goalRange),
                usedPath: false,
                pathIndex: 0,
                stalledTicks: 0,
                goalRange,
                goalType
            }
        };
    }

    // =========================================
    // Deterministic border protocol (fatigue-safe)
    // =========================================
    // Policy:
    // 1) Stage BOTH creeps on adjacent exit tiles on the correct edge.
    // 2) ONLY when BOTH have fatigue==0 and both are staged, cross together.
    // This avoids split/regroup ping-pong when one creep is fatigued.
    if (goalPos.roomName !== room.name) {
        const ignore = buildIgnoreSet(leader, support);

        // Cache exit-lane choice while border-handshaking to avoid PF jitter (48,21 <-> 48,22).
        // IMPORTANT: key by *next hop* (adjacent room), not the final destination.
        const goalKey = buildGoalKey(goalPos, goalType, goalRange);
        const bh = memory ? (memory.borderHandshake || (memory.borderHandshake = {})) : null;
        const finalDest = goalPos.roomName;
        const nextHopRoom = getNextHopRoomName(room.name, finalDest) || finalDest;

        const intendedExitDir = getExitDir(room.name, nextHopRoom);
        const intent = exitDirToEdgeAndCross(intendedExitDir);

        // Only engage border protocol when we're near the *intended* edge for the next hop.
        // After entering a room we often stand on an unrelated edge (x=0/x=49); engaging there causes split/regroup ping-pong.
        const borderEngage = intent
            ? (nearEdge(leader.pos, intent.edge, 1) || nearEdge(support.pos, intent.edge, 1))
            : (nearBorder(leader.pos, 1) || nearBorder(support.pos, 1));

        if (borderEngage) {

            const bhKey = `${room.name}->${nextHopRoom}:${goalKey}`;
            const borderDbg = debug ? {
                goalKey,
                bhKey,
                room: room.name,
                dest: nextHopRoom,
                finalDest,
                leader: serializePos(leader.pos),
                support: serializePos(support.pos)
            } : null;
            if (bh) {
                // Clear stale cache if room/destination/goal changed.
                if (bh.key !== bhKey) {
                    bh.key = bhKey;
                    bh.leaderExit = null;
                    bh.supportExit = null;
                    bh.ts = Game.time;
                }
            }

            // Pick a good exit lane for the leader (prefer PF-derived).
            let leaderExit = null;

            // Use cached exits when available (prevents oscillation due to considerCreeps/PF lane flips).
            if (bh && bh.leaderExit && bh.supportExit) {
                const cachedLeader = deserializePos(bh.leaderExit);
                const cachedSupport = deserializePos(bh.supportExit);
                const intendedExitDir = getExitDir(room.name, nextHopRoom);
                const intent = exitDirToEdgeAndCross(intendedExitDir);
                if (
                    cachedLeader && cachedSupport &&
                    cachedLeader.roomName === room.name &&
                    cachedSupport.roomName === room.name &&
                    isValidExitTile(room, cachedLeader) &&
                    isValidExitTile(room, cachedSupport) &&
                    sameEdge(cachedLeader, cachedSupport) &&
                    (!intent || (posOnEdge(cachedLeader, intent.edge) && posOnEdge(cachedSupport, intent.edge))) &&
                    !isSamePos(cachedLeader, cachedSupport)
                ) {
                    leaderExit = cachedLeader;
                    if (borderDbg) borderDbg.cacheUsed = 1;
                    // We'll set supportExit from cache below after we compute it.
                }
            }

            // Only treat "standing on border" as our chosen exit if it's on the intended edge.
            // Otherwise (common right after a room transition), this hijacks the handshake and makes the pair diverge.
            if (intent && posOnEdge(leader.pos, intent.edge)) leaderExit = leader.pos;
            if (!leaderExit) {
                leaderExit = pickExitTile(room, nextHopRoom, goalPos, {
                    fromPos: leader.pos,
                    targetPos: goalPos,
                    movement,
                    runtime,
                    ignoreCreepIds: ignore
                });
            }

            if (leaderExit && isExitTile(leaderExit)) {
                const crossDir = getBorderCrossDir(leaderExit);
                if (borderDbg) {
                    borderDbg.leaderExit = serializePos(leaderExit);
                    borderDbg.crossDir = crossDir;
                }
                // Choose a *pair* of valid exit tiles (side-by-side) on the correct edge.
                // Robustness: border terrain can contain natural walls (unwalkable exit tiles). If we only
                // "lock leaderExit" and pick support next to it, we can accidentally select a blocked tile.
                // Instead, choose the best adjacent pair, and allow shifting leaderExit within the edge.
                let supportExit = null;

                const intendedExitDirForPick = getExitDir(room.name, nextHopRoom);
                const intentForPick = exitDirToEdgeAndCross(intendedExitDirForPick);

                function buildEdgeRef(roomName, exitDir, referencePos) {
                    // Project referencePos onto the relevant border (same logic as pickExitTileByProjection).
                    if (!referencePos) return new RoomPosition(25, 25, roomName);
                    const rx = referencePos.x;
                    const ry = referencePos.y;
                    const cx = Math.max(0, Math.min(49, rx));
                    const cy = Math.max(0, Math.min(49, ry));
                    if (exitDir === FIND_EXIT_LEFT)   return new RoomPosition(0,  cy, roomName);
                    if (exitDir === FIND_EXIT_RIGHT)  return new RoomPosition(49, cy, roomName);
                    if (exitDir === FIND_EXIT_TOP)    return new RoomPosition(cx, 0,  roomName);
                    if (exitDir === FIND_EXIT_BOTTOM) return new RoomPosition(cx, 49, roomName);
                    return new RoomPosition(25, 25, roomName);
                }

                function pickBestExitPair() {
                    if (!intentForPick) return null;

                    // Gather all exit tiles on the intended edge.
                    const exits = room.find(intendedExitDirForPick);
                    if (!exits || exits.length === 0) return null;

                    const valid = [];
                    for (const e of exits) {
                        const p = new RoomPosition(e.x, e.y, room.name);
                        if (!isValidExitTile(room, p)) continue;
                        if (!posOnEdge(p, intentForPick.edge)) continue;
                        valid.push(p);
                    }
                    if (valid.length === 0) return null;

                    // Prefer adjacent pairs (side-by-side) to avoid conga.
                    const ref = buildEdgeRef(room.name, intendedExitDirForPick, goalPos || leader.pos);
                    let best = null;
                    let bestScore = Infinity;

                    // Helper to score an assignment (a->leader, b->support)
                    function scoreAssign(a, b) {
                        // bias toward being near the projected border ref, and toward each creep
                        const nearRef = ref.getRangeTo(a) + ref.getRangeTo(b);
                        const dl = leader.pos.getRangeTo(a);
                        const ds = support.pos.getRangeTo(b);
                        return nearRef * 2 + dl * 10 + ds * 10;
                    }

                    const seen = new Set();
                    for (const a of valid) {
                        const adj = adjacentExitCandidatesOnSameEdge(a);
                        for (const b of adj) {
                            if (!b) continue;
                            if (!isValidExitTile(room, b)) continue;
                            if (!posOnEdge(b, intentForPick.edge)) continue;
                            if (isSamePos(a, b)) continue;
                            const k1 = posKey(a);
                            const k2 = posKey(b);
                            const key = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
                            if (seen.has(key)) continue;
                            seen.add(key);

                            const s1 = scoreAssign(a, b);
                            const s2 = scoreAssign(b, a); // allow swapping assignment
                            if (s1 < bestScore) {
                                bestScore = s1;
                                best = { leaderExit: a, supportExit: b, swapped: 0 };
                            }
                            if (s2 < bestScore) {
                                bestScore = s2;
                                best = { leaderExit: b, supportExit: a, swapped: 1 };
                            }
                        }
                    }

                    if (best) return best;

                    // No adjacent pair exists (rare). Fallback:
                    // pick best single for leader and the nearest other valid tile for support (may conga).
                    let bestLeader = null;
                    let bestLeaderScore = Infinity;
                    for (const a of valid) {
                        const s = ref.getRangeTo(a) * 2 + leader.pos.getRangeTo(a) * 10;
                        if (s < bestLeaderScore) { bestLeaderScore = s; bestLeader = a; }
                    }
                    if (!bestLeader) return null;

                    let bestSupport = null;
                    let bestSupportScore = Infinity;
                    for (const b of valid) {
                        if (isSamePos(b, bestLeader)) continue;
                        const s = support.pos.getRangeTo(b) * 10 + ref.getRangeTo(b) * 2;
                        if (s < bestSupportScore) { bestSupportScore = s; bestSupport = b; }
                    }
                    if (!bestSupport) bestSupport = bestLeader;

                    return { leaderExit: bestLeader, supportExit: bestSupport, swapped: null };
                }

                // Reuse cached exits only if BOTH are still valid and on the intended edge.
                let pair = null;
                if (bh && bh.leaderExit && bh.supportExit && intentForPick) {
                    const cachedLeader = deserializePos(bh.leaderExit);
                    const cachedSupport = deserializePos(bh.supportExit);
                    if (
                        cachedLeader && cachedSupport &&
                        cachedLeader.roomName === room.name &&
                        cachedSupport.roomName === room.name &&
                        isValidExitTile(room, cachedLeader) &&
                        isValidExitTile(room, cachedSupport) &&
                        sameEdge(cachedLeader, cachedSupport) &&
                        posOnEdge(cachedLeader, intentForPick.edge) &&
                        posOnEdge(cachedSupport, intentForPick.edge) &&
                        !isSamePos(cachedLeader, cachedSupport)
                    ) {
                        pair = { leaderExit: cachedLeader, supportExit: cachedSupport, swapped: null };
                        if (borderDbg) borderDbg.cachePairUsed = 1;
                    }
                }

                if (!pair) pair = pickBestExitPair();

                if (pair && pair.leaderExit && pair.supportExit) {
                    leaderExit = pair.leaderExit;
                    supportExit = pair.supportExit;
                } else {
                    // Last resort: keep leaderExit (already chosen) and try to find ANY other valid exit tile.
                    const cand = adjacentExitCandidatesOnSameEdge(leaderExit).filter(p => !isSamePos(p, leaderExit) && isValidExitTile(room, p));
                    supportExit = cand[0] || leaderExit;
                }

                // Persist chosen exit tiles for this handshake to avoid oscillation.
                if (bh && leaderExit && supportExit) {
                    bh.leaderExit = serializePos(leaderExit);
                    bh.supportExit = serializePos(supportExit);
                    bh.ts = Game.time;
                }
                if (borderDbg) borderDbg.supportExit = serializePos(supportExit);

                // === PRE-CROSS STAGING (side-by-side one tile inward) ===
                // Goal: before stepping onto the exit line, force the pair to form up on the "pre-cross" line
                // (x==1/48 or y==1/48 depending on edge), *aligned to their specific exit tiles*.
                // This prevents edge-cases where a creep is on the pre-line but not adjacent to its own exit tile,
                // causing early/accidental crossings into wall segments.
                const origLeaderExit = leaderExit;
                const origSupportExit = supportExit;

                function inwardFromExit(exitPos) {
                    if (!exitPos) return null;
                    if (exitPos.x === 0) return new RoomPosition(1, exitPos.y, exitPos.roomName);
                    if (exitPos.x === 49) return new RoomPosition(48, exitPos.y, exitPos.roomName);
                    if (exitPos.y === 0) return new RoomPosition(exitPos.x, 1, exitPos.roomName);
                    if (exitPos.y === 49) return new RoomPosition(exitPos.x, 48, exitPos.roomName);
                    return null;
                }

                function isPreLine(pos, pre) {
                    if (!pos || !pre) return false;
                    if (pre.x === 1 || pre.x === 48) return pos.x === pre.x; // vertical line
                    if (pre.y === 1 || pre.y === 48) return pos.y === pre.y; // horizontal line
                    return false;
                }

                function areSideBySideOnPreLine(a, b, pre) {
                    if (!a || !b || !pre) return false;
                    if (!isPreLine(a, pre) || !isPreLine(b, pre)) return false;
                    if (pre.x === 1 || pre.x === 48) return a.x === b.x && Math.abs(a.y - b.y) === 1;
                    if (pre.y === 1 || pre.y === 48) return a.y === b.y && Math.abs(a.x - b.x) === 1;
                    return false;
                }

                const leaderPre = inwardFromExit(origLeaderExit);
                const supportPre = inwardFromExit(origSupportExit);

                if (borderDbg) borderDbg.pre = { leaderPre: serializePos(leaderPre), supportPre: serializePos(supportPre) };

                // Only do pre-cross staging when we are in the room BEFORE crossing (goal room differs).
                // Once both are on the exit tiles, the existing atomic cross logic applies.
                if (leaderPre && supportPre && goalPos && goalPos.roomName !== room.name && !isExitTile(leader.pos) && !isExitTile(support.pos)) {
                    const leaderOnPre = isSamePos(leader.pos, leaderPre);
                    const supportOnPre = isSamePos(support.pos, supportPre);

                    // "Properly formed" means:
                    // - each creep is on its own pre-tile (the tile directly inside its chosen exit),
                    // - and the two pre-tiles are side-by-side on the pre-line.
                    const preSideBySide = areSideBySideOnPreLine(leaderPre, supportPre, leaderPre);
                    const formed = leaderOnPre && supportOnPre && preSideBySide;

                    if (borderDbg) {
                        borderDbg.pre.leaderOnPre = leaderOnPre ? 1 : 0;
                        borderDbg.pre.supportOnPre = supportOnPre ? 1 : 0;
                        borderDbg.pre.preSideBySide = preSideBySide ? 1 : 0;
                        borderDbg.pre.formed = formed ? 1 : 0;
                    }

                    if (!formed) {
                        // Stage onto the exact pre tiles first.
                        leaderExit = leaderPre;
                        supportExit = supportPre;

                        // Extra guard: if one of the pre tiles is unexpectedly blocked, fall back to original exit staging
                        // rather than deadlocking (PF will then pick the closest workable staging).
                        const tL = room.getTerrain().get(leaderPre.x, leaderPre.y);
                        const tS = room.getTerrain().get(supportPre.x, supportPre.y);
                        if (tL === TERRAIN_MASK_WALL || tS === TERRAIN_MASK_WALL || isBlockedByStructureAt(room, leaderPre) || isBlockedByStructureAt(room, supportPre)) {
                            leaderExit = origLeaderExit;
                            supportExit = origSupportExit;
                        }
                    } else {
                        // Already formed on pre-line => next step is to move ONTO the exit line (x/y==0/49).
                        leaderExit = origLeaderExit;
                        supportExit = origSupportExit;
                    }
                }

                const stageOpts = {
                    considerCreeps: true,
                    ignoreCreepIds: ignore,
                    avoidBorders: false, // we WANT to step onto exits during staging
                    maxRooms: 1,
                    inject: memory ? getInject(memory) : null
                };

                const leaderStaged = isSamePos(leader.pos, leaderExit);
                const supportStaged = isSamePos(support.pos, supportExit);
                if (borderDbg) {
                    borderDbg.stage = {
                        leaderStaged: leaderStaged ? 1 : 0,
                        supportStaged: supportStaged ? 1 : 0,
                        leaderExit: serializePos(leaderExit),
                        supportExit: serializePos(supportExit)
                    };
                }

                // If not staged, PF both toward their staging tiles.
                if (!leaderStaged || !supportStaged) {
                    const l = leaderStaged
                        ? { dir: null, to: leader.pos, ps: memory ? getPathState(memory, 'border_stage_leader') : null }
                        : pfStepToward(memory && usePathCache ? memory : null, 'border_stage_leader', leader, leaderExit, 0, movement, runtime, stageOpts, leaderExit, false);

                    const s = supportStaged
                        ? { dir: null, to: support.pos, ps: memory ? getPathState(memory, 'border_stage_support') : null }
                        : pfStepToward(memory && usePathCache ? memory : null, 'border_stage_support', support, supportExit, 0, movement, runtime, stageOpts, supportExit, false);
                    if (borderDbg) {
                        borderDbg.stage.leaderTo = serializePos(l.to || leader.pos);
                        borderDbg.stage.supportTo = serializePos(s.to || support.pos);
                    }

                    
                    // --- Choke-lane swap / yield (border staging) ---
                    // In 1-tile entrances, the staged creep can block the other from reaching its staging tile.
                    // Allow a deliberate SWAP (or yield) so the pair can "thread the needle" without deadlocking.
                    const trySwapOrYield = () => {
                        // Only meaningful when adjacent.
                        if (leader.pos.getRangeTo(support.pos) !== 1) return false;

                        const leaderBlocksSupport =
                            leaderStaged &&
                            !supportStaged &&
                            supportExit &&
                            leader.pos.getRangeTo(supportExit) < support.pos.getRangeTo(supportExit);

                        const supportBlocksLeader =
                            supportStaged &&
                            !leaderStaged &&
                            leaderExit &&
                            support.pos.getRangeTo(leaderExit) < leader.pos.getRangeTo(leaderExit);

                        if (!leaderBlocksSupport && !supportBlocksLeader) return false;

                        // 1) Prefer a clean swap (leader <-> support) if both can step into each other's tiles.
                        const swapPlan = buildMovePlan(leader, support, support.pos, leader.pos);
                        const canSwapLeader = isPassableForLeader(room, support.pos, leader, support, swapPlan);
                        const canSwapSupport = isPassableForSupport(room, leader.pos, leader, support, swapPlan);
                        if (canSwapLeader && canSwapSupport) {
                            l.dir = leader.pos.getDirectionTo(support.pos);
                            l.to = support.pos;
                            s.dir = support.pos.getDirectionTo(leader.pos);
                            s.to = leader.pos;
                            return true;
                        }

                        // 2) Swap not possible -> yield: move the blocking (staged) creep off the lane 1 tile
                        // (prefer inward directions) while the other steps into the vacated tile.
                        const followerWants = leaderBlocksSupport ? leader.pos : support.pos;

                        const dirs = inwardDirs((leaderBlocksSupport ? leader : support).pos).concat(DIRS);
                        const seen = new Set();
                        for (const d of dirs) {
                            if (seen.has(d)) continue;
                            seen.add(d);

                            const blocker = leaderBlocksSupport ? leader : support;
                            const next = dirToPos(blocker.pos, d);
                            if (!next) continue;
                            if (isSamePos(next, (leaderBlocksSupport ? support : leader).pos)) continue;

                            const plan = leaderBlocksSupport
                                ? buildMovePlan(leader, support, next, followerWants)
                                : buildMovePlan(leader, support, followerWants, next);

                            const okBlocker = leaderBlocksSupport
                                ? isPassableForLeader(room, next, leader, support, plan)
                                : isPassableForSupport(room, next, leader, support, plan);

                            const okFollower = leaderBlocksSupport
                                ? isPassableForSupport(room, followerWants, leader, support, plan)
                                : isPassableForLeader(room, followerWants, leader, support, plan);

                            if (!okBlocker || !okFollower) continue;

                            if (leaderBlocksSupport) {
                                l.dir = leader.pos.getDirectionTo(next);
                                l.to = next;
                                s.dir = support.pos.getDirectionTo(followerWants);
                                s.to = followerWants;
                            } else {
                                s.dir = support.pos.getDirectionTo(next);
                                s.to = next;
                                l.dir = leader.pos.getDirectionTo(followerWants);
                                l.to = followerWants;
                            }
                            return true;
                        }

                        return false;
                    };

                    trySwapOrYield();

// Prevent support from stepping onto leader's CURRENT tile during border staging.
                    // This avoids "support stacks onto leader then crosses" conga behavior on the pre-cross side.
                    // HOWEVER: allow stepping into leader's current tile if the leader is vacating it this tick (swap / move-into-vacated).
                    if (!supportStaged && s && s.to && isSamePos(s.to, leader.pos)) {
                        const leaderIsMovingAway = l && l.to && !isSamePos(l.to, leader.pos);
                        if (!leaderIsMovingAway) {
                            s.dir = null;
                            s.to = support.pos;
                        }
                    }


                // Prevent leader from pathing onto support's CURRENT tile during border staging.
                // PF treats creeps as high-cost, not blocked, so it may still choose the support tile.
                // If support is not vacating this tick, that becomes a hard deadlock (leader tries to move into occupied tile).
                if (!leaderStaged && l && l.to && isSamePos(l.to, support.pos)) {
                    const supportIsMovingAway = s && s.to && !isSamePos(s.to, support.pos);
                    if (!supportIsMovingAway) {
                        // Try one quick reroute by injecting a short-lived hard block on the support tile.
                        if (memory) {
                            addTempBlock(memory, room.name, support.pos, 3, 255);
                            invalidatePath(memory, 'border_stage_leader');
                        }
                        const l2 = pfStepToward(
                            memory && usePathCache ? memory : null,
                            'border_stage_leader',
                            leader,
                            leaderExit,
                            0,
                            movement,
                            runtime,
                            stageOpts,
                            leaderExit,
                            true // forceRecalc
                        );
                        if (l2 && l2.to) {
                            l.dir = l2.dir;
                            l.to = l2.to;
                            l.ps = l2.ps;
                        }

                        // If we STILL want to step onto support, hold leader (prefer 1-tick delay over permanent deadlock).
                        if (l && l.to && isSamePos(l.to, support.pos)) {
                            l.dir = null;
                            l.to = leader.pos;
                        }
                    }
                }                
                
                return {
                        ok: true,
                        reason: 'border-stage',
                        mode: 'BORDER_HANDSHAKE',
                        cohesive: (l.to || leader.pos).getRangeTo(s.to || support.pos) <= cohesionRange,
                        sameRoom: true,
                        dist,
                        step: applyBorderHygieneToStep(
                            buildStepResult(leader, support, l.to || leader.pos, s.to || support.pos),
                            leader,
                            support
                        ),
                        meta: { goalKey: buildGoalKey(goalPos, goalType, goalRange), usedPath: false, pathIndex: 0, stalledTicks: 0, goalRange, goalType },
                        debug: debug ? { reason: 'border-stage', border: borderDbg } : undefined
                    };
                }
                // Both staged:
                // - If either creep has fatigue, HOLD on staging tiles (safe).
                // - If both are unfatigued, commit an explicit cross intent together.
                //
                // Note: Crossing is expressed as { to: currentPos, dir: crossDir } (see isCrossIntent()).
                const intendedExitDir = getExitDir(room.name, nextHopRoom);
                const intent = exitDirToEdgeAndCross(intendedExitDir);
                const canCross =
                    intent &&
                    posOnEdge(leader.pos, intent.edge) &&
                    posOnEdge(support.pos, intent.edge) &&
                    leader.fatigue === 0 &&
                    support.fatigue === 0;
                if (borderDbg) {
                    borderDbg.cross = {
                        intendedExitDir,
                        edge: intent ? intent.edge : null,
                        canCross: canCross ? 1 : 0,
                        leaderFatigue: leader.fatigue || 0,
                        supportFatigue: support.fatigue || 0
                    };
                }

                if (canCross) {
                    const crossDir2 = intent.crossDir;
                    const crossStep = {
                        leaderDir: crossDir2,
                        leaderTo: leader.pos,
                        supportDir: crossDir2,
                        supportTo: support.pos
                    };

                    // Optional: clear handshake cache once we commit the cross.
                    if (bh) {
                        bh.key = null;
                        bh.leaderExit = null;
                        bh.supportExit = null;
                        bh.ts = Game.time;
                    }

                    return {
                        ok: true,
                        reason: 'border-cross',
                        mode: 'BORDER_HANDSHAKE',
                        cohesive: true,
                        sameRoom: true,
                        dist,
                        step: applyBorderHygieneToStep(crossStep, leader, support),
                        meta: { goalKey: buildGoalKey(goalPos, goalType, goalRange), usedPath: false, pathIndex: 0, stalledTicks: 0, goalRange, goalType },
                        debug: debug ? { edge: intent.edge, crossDir: crossDir2, reason: 'border-cross', border: borderDbg } : undefined
                    };
                }

                // Both staged but cannot cross this tick (fatigue / wrong edge / no exit dir): HOLD.
                return {
                    ok: true,
                    reason: 'border-stage-hold',
                    mode: 'HOLD',
                    cohesive: true,
                    sameRoom: true,
                    dist,
                    step: applyBorderHygieneToStep(buildStepResult(leader, support, leader.pos, support.pos), leader, support),
                    meta: { goalKey: buildGoalKey(goalPos, goalType, goalRange), usedPath: false, pathIndex: 0, stalledTicks: 0, goalRange, goalType },
                    debug: debug ? { reason: 'border-stage-hold', border: borderDbg } : undefined
                };
            }
        }

    }

    // Decide whether leader should HOLD (goal reached) or step.
    const goalReached = isGoalReached(leader.pos, { pos: goalPos, type: goalType, range: goalRange });
    let leaderTo = leader.pos;
    let leaderDir = null;

    const travelOpts = {
        considerCreeps: true,
        ignoreCreepIds: buildIgnoreSet(leader, support),
        avoidBorders: movement.avoidBorders !== false,
        maxRooms: 16,
        inject: memory ? getInject(memory) : null
    };

    let travelPS = memory ? getPathState(memory, 'travel') : null;
    let usedPath = false;
    let pathIndex = 0;

    if (!goalReached) {
        const step = pfStepToward(
            memory && usePathCache ? memory : null,
            'travel',
            leader,
            goalPos,
            goalType === 'RANGE' ? goalRange : 0,
            movement,
            runtime,
            travelOpts,
            null,
            false
        );

        leaderDir = step.dir;
        leaderTo = step.to || leader.pos;

        if (memory && usePathCache) {
            travelPS = step.ps || travelPS;
            usedPath = true;
            pathIndex = travelPS ? (travelPS.idx || 0) : 0;
        }
    }

    // SAME-ROOM REGROUP trigger:
    // - distance > cohesionRange
    // - support currently unsafe
    // - OR no safe cohesive joint step exists
    const supportUnsafeNow = isUnsafeForSupport(room, support.pos, runtime, { allowExit: false });
    let needRegroup = (!allowSplit && dist > cohesionRange) || supportUnsafeNow;

    // Attempt cohesive plan first if not forced to regroup
    if (!needRegroup && !allowSplit) {
        const provisional = buildMovePlan(leader, support, leaderTo, support.pos);
        const supportTo = computeSupportCohesive(room, leader, support, leaderTo, leaderDir, formation, provisional, runtime, cohesionRange, enemyPos);

        if (supportTo) {

            // Yield-to-leader rule:
            // If the leader's intended tile is currently occupied by the support, the support MUST vacate
            // to avoid deadlocks (PF often prefers stepping "through" the support).
            // Preference order:
            //  1) Sidestep to a safe adjacent tile near the leader's intended end (NOT swap)
            //  2) Swap (support -> leader.pos) as the fallback, even if unsafe (still must be walkable)
            let desiredSupportTo = supportTo;

            if (!goalReached && isSamePos(leaderTo, support.pos)) {
                // 1) Try to vacate without swapping into leader's tile.
                const sidestepCandidates = [];
                const adj = getAdjacentTo(leaderTo);
                for (let i = 0; i < adj.length; i++) {
                    const p = adj[i];
                    if (!p) continue;

                    // must be a 1-tick move (or would be hold; but hold would deadlock)
                    if (support.pos.getRangeTo(p) > 1) continue;

                    // avoid swapping as "better tile"
                    if (isSamePos(p, leader.pos)) continue;

                    // never end on exits in cohesive mode
                    if (isExitTile(p)) continue;

                    // must remain within cohesion constraint relative to leaderTo
                    if (p.roomName !== leaderTo.roomName) continue;
                    if (p.getRangeTo(leaderTo) > cohesionRange) continue;

                    // passability with same-tick vacating/claimed rules
                    const plan = buildMovePlan(leader, support, leaderTo, p);
                    const can = isPassableForSupport(room, p, leader, support, plan);
                    if (!can) continue;

                    // safety: keep the usual hard safety rule for sidestep tiles
                    if (isUnsafeForSupport(room, p, runtime, { allowExit: false })) continue;

                    // score: prefer tiles that keep support not "more forward" than leader vs enemy ref
                    let score = 0;
                    const dIntended = p.getRangeTo(leaderTo);
                    score += dIntended * 50; // should be 1 for adjacency; keep it decisive

                    if (enemyPos && enemyPos.roomName === leaderTo.roomName) {
                        const dEnemySupport = p.getRangeTo(enemyPos);
                        const dEnemyLeader = leaderTo.getRangeTo(enemyPos);
                        if (dEnemySupport < dEnemyLeader) score += (dEnemyLeader - dEnemySupport) * 40;
                    }

                    // stable tie-break by generation order
                    score += i;

                    sidestepCandidates.push({ pos: p, score });
                }

                if (sidestepCandidates.length > 0) {
                    sidestepCandidates.sort((a, b) => a.score - b.score);
                    desiredSupportTo = sidestepCandidates[0].pos;
                } else if (allowSwap) {
                    // 2) Swap fallback: support moves into leader's current tile.
                    // Allow this even if unsafe, because deadlock is worse than a 1-tick "least bad" move.
                    const swapTo = leader.pos;

                    // Keep basic walkability constraints.
                    const terrain = room.getTerrain().get(swapTo.x, swapTo.y);
                    const walkable = terrain !== TERRAIN_MASK_WALL && !isExitTile(swapTo) && !isBlockedByStructureAt(room, swapTo);

                    if (walkable) {
                        const plan = buildMovePlan(leader, support, leaderTo, swapTo);
                        if (isPassableForSupport(room, swapTo, leader, support, plan)) {
                            desiredSupportTo = swapTo;
                        }
                    }
                }
            }

            // Pre-cross staging: if leaderTo is an edge tile for next room, force support to trail into leader.pos.
            if (needsPreCrossStaging(room.name, goalPos, leaderTo)) {
                if (support.pos.getRangeTo(leader.pos) <= 1) {
                    const trailPlan = buildMovePlan(leader, support, leaderTo, leader.pos);
                    if (isPassableForSupport(room, leader.pos, leader, support, trailPlan)) {
                        // override supportTo (trail)
                        desiredSupportTo = leader.pos;
                    }
                }
            }

            const finalSupportTo = (needsPreCrossStaging(room.name, goalPos, leaderTo) && support.pos.getRangeTo(leader.pos) <= 1)
                ? leader.pos
                : desiredSupportTo;

            const movePlan = buildMovePlan(leader, support, leaderTo, finalSupportTo);

            const canLeader = isPassableForLeader(room, leaderTo, leader, support, movePlan) || isSamePos(leaderTo, leader.pos);
            const canSupport = isPassableForSupport(room, finalSupportTo, leader, support, movePlan) || isSamePos(finalSupportTo, support.pos);

            const swapAllowed = allowSwap && isSamePos(leaderTo, support.pos) && isSamePos(finalSupportTo, leader.pos);
            const collision = isSamePos(leaderTo, finalSupportTo) && !swapAllowed;

            if (canLeader && canSupport && !collision && isCohesionOk(leaderTo, finalSupportTo, cohesionRange, false)) {
                return {
                    ok: true,
                    reason: 'cohesive',
                    mode: goalReached ? 'HOLD' : 'COHESIVE',
                    cohesive: true,
                    sameRoom: true,
                    dist,
                    step: applyBorderHygieneToStep(buildStepResult(leader, support, leaderTo, finalSupportTo), leader, support),
                    meta: {
                        goalKey: buildGoalKey(goalPos, goalType, goalRange),
                        usedPath,
                        pathIndex,
                        stalledTicks: travelPS ? (travelPS.stalledTicks || 0) : 0,
                        goalRange,
                        goalType
                    }
                };
            }
        }

        // No valid cohesive step => enter regroup
        needRegroup = true;
    }

    // SAME-ROOM REGROUP MODE
    if (!allowSplit && needRegroup) {
        const meetPos = selectMeetPos(room, leader, support, runtime);

        const provisional = buildMovePlan(leader, support, leader.pos, support.pos);
        markVacating(provisional, leader.pos);
        markVacating(provisional, support.pos);

        const regroupOpts = {
            considerCreeps: true,
            ignoreCreepIds: buildIgnoreSet(leader, support),
            vacatingPosKeys: provisional.vacating,
            avoidBorders: true,
            maxRooms: 1,
            inject: memory ? getInject(memory) : null
        };

        // Leader step toward meetPos (range 0 if not already there)
        const lStep = isSamePos(leader.pos, meetPos)
            ? { dir: null, to: leader.pos, ps: memory ? getPathState(memory, 'regroup_leader') : null }
            : pfStepToward(memory && usePathCache ? memory : null, 'regroup_leader', leader, meetPos, 0, movement, runtime, regroupOpts, null, false);

        // Support step toward meetPos; if meetPos is leader.pos, use range=1 to avoid collision.
        const sRange = isSamePos(meetPos, leader.pos) ? 1 : 0;
        const sStep = pfStepToward(memory && usePathCache ? memory : null, 'regroup', support, meetPos, sRange, movement, runtime, regroupOpts, null, false);

        let leaderToR = lStep.to || leader.pos;
        let supportToR = sStep.to || support.pos;

        // REGROUP convergence: both creeps PF toward meetPos to re-form quickly.
        // We keep one small guard: if the leader's planned step would *increase* separation
        // relative to the support's planned end, prefer holding the leader (prevents "running away").
        //
        // NOTE: border hygiene is still enforced later by applyBorderHygieneToStep(...).
        try {
            if (leaderToR && supportToR && leaderToR.getRangeTo(supportToR) > leader.pos.getRangeTo(supportToR)) {
                leaderToR = leader.pos;
            }
        } catch (e) {
            leaderToR = leader.pos;
        }

        // Fail-safe: prevent illegal stacking.
        // Prefer letting the leader advance while the support HOLDS (faster convergence),
        // but never allow the leader to step onto a non-vacating support tile unless it's a swap.
        let swapAllowed = allowSwap && isSamePos(leaderToR, support.pos) && isSamePos(supportToR, leader.pos);
        if (isSamePos(leaderToR, supportToR) && !swapAllowed) {
            // If both planned to end on the same tile, try holding support first.
            if (!isSamePos(leaderToR, support.pos)) {
                supportToR = support.pos;
            } else {
                // leaderToR is support.pos (leader trying to step onto support while support also goes there) -> full hold.
                leaderToR = leader.pos;
                supportToR = support.pos;
            }
        }

        // Build plan AFTER any adjustments.
        const movePlan = buildMovePlan(leader, support, leaderToR, supportToR);
        swapAllowed = allowSwap && isSamePos(leaderToR, support.pos) && isSamePos(supportToR, leader.pos);

        // If regroup still can't produce a legal move, both hold.
        const okLeader = isSamePos(leaderToR, leader.pos) || isPassableForLeader(room, leaderToR, leader, support, movePlan);
        const okSupport = isSamePos(supportToR, support.pos) || isPassableForSupport(room, supportToR, leader, support, movePlan);

        if (!okLeader || !okSupport) {
            // stall handling for cached paths
            if (memory && usePathCache) {
                const lps = getPathState(memory, 'regroup_leader');
                const sps = getPathState(memory, 'regroup');
                if (lps && !lps.lastToKey) markStall(lps);
                if (sps && !sps.lastToKey) markStall(sps);
                if (lps && (lps.stalledTicks || 0) >= stallRepathTicks) invalidatePath(memory, 'regroup_leader');
                if (sps && (sps.stalledTicks || 0) >= stallRepathTicks) invalidatePath(memory, 'regroup');
            }

            return {
                ok: false,
                reason: 'regroup-blocked',
                mode: 'REGROUP',
                cohesive: false,
                sameRoom: true,
                dist,
                step: applyBorderHygieneToStep(buildStepResult(leader, support, leader.pos, support.pos), leader, support),
                meta: { goalKey: buildGoalKey(goalPos, goalType, goalRange), usedPath: false, pathIndex: 0, stalledTicks: 0, goalRange, goalType }
            };
        }

        return {
            ok: true,
            reason: 'regroup',
            mode: 'REGROUP',
            cohesive: (leaderToR.getRangeTo(supportToR) <= cohesionRange),
            sameRoom: true,
            dist,
            step: applyBorderHygieneToStep(buildStepResult(leader, support, leaderToR, supportToR), leader, support),
            meta: { goalKey: buildGoalKey(goalPos, goalType, goalRange), usedPath: false, pathIndex: 0, stalledTicks: 0, goalRange, goalType }
        };
    }

    // Split explicitly allowed: best-effort PF for leader; support HOLD if safe else follow cohesive pick without cohesion hard-stop.
    const provisional = buildMovePlan(leader, support, leaderTo, support.pos);
    let supportTo = computeSupportCohesive(room, leader, support, leaderTo, leaderDir, formation, provisional, runtime, Math.max(1, Math.min(1, cohesionRange)), enemyPos);
    if (!supportTo) supportTo = support.pos;

    return {
        ok: true,
        reason: 'split-allowed',
        mode: 'SPLIT',
        cohesive: false,
        sameRoom: true,
        dist,
        step: applyBorderHygieneToStep(buildStepResult(leader, support, leaderTo, supportTo), leader, support),
        meta: { goalKey: buildGoalKey(goalPos, goalType, goalRange), usedPath, pathIndex, stalledTicks: travelPS ? (travelPS.stalledTicks || 0) : 0, goalRange, goalType }
    };
}

module.exports = {
    plan: planV3
};
