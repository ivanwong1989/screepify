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

function nowTick() {
    return (typeof Game !== 'undefined' && Game.time != null) ? Game.time : 0;
}

function logSolo(runtime, enabled, message) {
    if (!enabled || !global || typeof global.debug !== 'function') return;
    global.debug('admiral.assault.solo', `[assault.solo] ${message}`);

    if (runtime && runtime.debug) {
        const now = nowTick();
        if (runtime.debug.lastLogTick === now && runtime.debug.lastLog === message) return;
        runtime.debug.lastLogTick = now;
        runtime.debug.lastLog = message;
    }
}

function logCtx(creep, opts) {
    const creepName = creep && creep.name ? creep.name : 'unknown';
    const missionName = opts && opts.missionName ? opts.missionName : null;
    return missionName ? `mission=${missionName} creep=${creepName} ` : `creep=${creepName} `;
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

function getPfDebug(mem) {
    if (!mem) return null;
    if (!mem.debug || typeof mem.debug !== 'object') mem.debug = {};
    if (!mem.debug.once || typeof mem.debug.once !== 'object') mem.debug.once = {};
    return mem.debug;
}

function logOncePerTick(runtime, mem, enabled, key, message) {
    if (!enabled) return;
    const dbg = getPfDebug(mem);
    if (!dbg) {
        logSolo(runtime, enabled, message);
        return;
    }
    const now = nowTick();
    if (dbg.once[key] === now) return;
    dbg.once[key] = now;
    logSolo(runtime, enabled, message);
}

function getInject(mem) {
    if (!mem) return null;
    if (!mem.inject || typeof mem.inject !== 'object') mem.inject = { byRoom: {} };
    if (!mem.inject.byRoom) mem.inject.byRoom = {};
    return mem.inject;
}

function addTempBlock(mem, roomName, pos, ttlTicks, cost = 255) {
    if (!mem || !roomName || !pos) return;
    const inject = getInject(mem);
    if (!inject) return;

    const r = inject.byRoom[roomName] || (inject.byRoom[roomName] = {});
    const key = `${pos.x}:${pos.y}`;
    const until = Game.time + (Number.isFinite(ttlTicks) ? ttlTicks : 5);

    // keep the max expiry if re-added
    const prev = r[key];
    r[key] = {
        until: prev ? Math.max(prev.until || 0, until) : until,
        cost: Number.isFinite(cost) ? cost : 255
    };
}

function purgeTempBlocks(mem) {
    const inject = getInject(mem);
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
        logSolo(runtime, !!(opts && opts.debug), 'planner: no valid goal');
        return { moveTarget: null, range: 0, reason: 'fallback:no-goal' };
    }

    // Range to consider "arrived". Defaults to 1 tile.
    const range = Number.isFinite(opts.range) ? opts.range : (Number.isFinite(opts.desiredRange) ? opts.desiredRange : 1);
    const logEnabled = (opts.logSolo != null) ? !!opts.logSolo : !!opts.debug;
    const purpose = (opts && opts.cacheKey) ? opts.cacheKey : 'path';
    const ctx = logCtx(creep, opts);

    // Cross-room: keep letting your higher-level route planner do it.
    // PF still can do multi-room, but your existing system already handles strategic routing.
    if (goalPos.roomName !== creep.room.name) {
        logSolo(runtime, logEnabled, `planner: ${ctx}cross-room ${formatPos(creep.pos)} -> ${formatPos(goalPos)} range=${range}`);
        return {
            moveTarget: { x: goalPos.x, y: goalPos.y, roomName: goalPos.roomName },
            range,
            reason: 'fallback:cross-room'
        };
    }

    // If we are already in range, hold.
    if (creep.pos.inRangeTo(goalPos.x, goalPos.y, range)) {
        logSolo(runtime, logEnabled, `planner: ${ctx}in-range ${formatPos(creep.pos)} -> ${formatPos(goalPos)} range=${range}`);
        return { moveTarget: null, range: 0, reason: 'hold:in-range' };
    }

    // --- PF cache memory ---
    const mem = getPfMemory(runtime);

    // Purge expired local PF injections (traffic blockers etc.)
    if (mem) purgeTempBlocks(mem);

    // Tick PF progress/stall (duo-style)
    const stallRepathTicks = Number.isFinite(opts.stallRepathTicks) ? opts.stallRepathTicks : 2;
    if (mem) {
        const p = getPathState(mem, purpose);

        // Capture the expected tile BEFORE tickProgress may clear it.
        const expectedKey = p && p.lastToKey ? String(p.lastToKey) : null;
        const fatigued = Number.isFinite(creep.fatigue) && creep.fatigue > 0;
        const prog = fatigued
            ? { advanced: false, stalled: false }
            : tickProgress(p, posKey(creep.pos), stallRepathTicks);

        if (fatigued && expectedKey) {
            logOncePerTick(
                runtime,
                mem,
                logEnabled,
                `fatigue:${creep.name}`,
                `planner: fatigue creep=${creep.name} fatigue=${creep.fatigue} suppress-stall expected=${expectedKey}`
            );
        }

        if (prog && (prog.advanced || prog.stalled)) {
            const status = prog.advanced ? 'advanced' : 'stalled';
            logSolo(
                runtime,
                logEnabled,
                `planner: ${status} creep=${creep.name} pos=${formatPos(creep.pos)} expected=${expectedKey || 'none'} purpose=${purpose}`
            );
        }

        // If we stalled, temporarily "block" the expected tile so PF will route around traffic.
        if (prog && prog.stalled && expectedKey) {
            const parts = expectedKey.split(':'); // room:x:y
            if (parts.length === 3) {
                const [rn, xs, ys] = parts;
                const x = Number(xs), y = Number(ys);
                if (Number.isFinite(x) && Number.isFinite(y)) {
                    addTempBlock(mem, rn, { x, y }, 5, 255);
                    logSolo(runtime, logEnabled, `planner: inject block ${rn}:${x},${y} ttl=5`);
                }
            }
        }
    }

        // --- PF options ---

    const pathReuseTicks = Number.isFinite(opts.pathReuseTicks) ? opts.pathReuseTicks : 25;
    const forceRecalc = !!opts.forceRecalc;

    // ✅ No internal combat matrix construction in soloPlanner.
    // We take the base CostMatrix from the *runtime-provided* roomCallback (built by controller/task-runner),
    // then apply soloPlanner's short-lived local injections on top when needed.
    //
    // Expected shapes:
    // - opts.roomCallback(roomName) -> CostMatrix   (explicit override)
    // - runtime.roomCallback(roomName) -> CostMatrix (default provided by military task runner)
    const baseRoomCallback =
        (opts && typeof opts.roomCallback === 'function') ? opts.roomCallback :
        (runtime && typeof runtime.roomCallback === 'function') ? runtime.roomCallback :
        null;

    // PF roomCallback with local, short-lived "traffic blocker" injections (TTL ~5 ticks)
    const pfRoomCallback = (roomName) => {
        const mat = baseRoomCallback ? baseRoomCallback(roomName) : undefined;
        if (!mat) {
            logOncePerTick(
                runtime,
                mem,
                logEnabled,
                `rcb:${roomName}:none`,
                `planner: roomCallback room=${roomName} base=none`
            );
            return undefined;
        }

        const inj = mem && mem.inject && mem.inject.byRoom ? mem.inject.byRoom[roomName] : null;
        if (!inj || Object.keys(inj).length === 0) {
            logOncePerTick(
                runtime,
                mem,
                logEnabled,
                `rcb:${roomName}:base`,
                `planner: roomCallback room=${roomName} base=ok injections=0`
            );
            return mat;
        }

        // Clone only when we actually have injections to apply.
        const cloned = mat.clone();
        let applied = 0;
        for (const key in inj) {
            const rec = inj[key];
            if (!rec || (rec.until || 0) <= Game.time) continue;

            const parts = String(key).split(':');
            if (parts.length !== 2) continue;
            const x = Number(parts[0]);
            const y = Number(parts[1]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

            const c = Number.isFinite(rec.cost) ? rec.cost : 255;
            const prev = cloned.get(x, y);
            cloned.set(x, y, Math.max(prev, c));
            applied += 1;
        }
        logOncePerTick(
            runtime,
            mem,
            logEnabled,
            `rcb:${roomName}:inj`,
            `planner: roomCallback room=${roomName} base=ok injections=${applied}`
        );
        return cloned;
    };

    const pfRange = range;

    logOncePerTick(
        runtime,
        mem,
        logEnabled,
        `pfopts:${creep.name}`,
        `planner: pf opts creep=${creep.name} purpose=${purpose} range=${pfRange} reuse=${pathReuseTicks} force=${forceRecalc}`
    );

    const { to: pfTo, ps } = pfStepToward(mem, purpose, creep, goalPos, pfRange, {
        maxRooms: 16,
        pathReuseTicks: forceRecalc ? 0 : pathReuseTicks,
        forceRecalc,
        roomCallback: pfRoomCallback
    });

    // If PF has no step, just fallback to direct goal (moveTo can handle local).
    if (!pfTo) {
        logSolo(
            runtime,
            logEnabled,
            `planner: no-pf-step creep=${creep.name} pos=${formatPos(creep.pos)} goal=${formatPos(goalPos)} range=${pfRange} force=${forceRecalc}`
        );
        return {
            moveTarget: { x: goalPos.x, y: goalPos.y, roomName: goalPos.roomName },
            range,
            reason: 'fallback:no-pf-step'
        };
    }

    // If PF step is blocked dynamically (traffic), inject a short-lived "block" on that tile
    // and force a repath immediately. This prevents infinite HOLD loops behind miners/haulers.
    if (!isPassable(creep.room, pfTo, creep.id)) {
        if (mem) addTempBlock(mem, creep.room.name, pfTo, 5, 255);
        logSolo(
            runtime,
            logEnabled,
            `planner: pf-step-blocked creep=${creep.name} to=${formatPos(pfTo)} injecting-block`
        );

        // Invalidate cached path state (we want a clean recompute).
        if (ps) {
            ps.steps = [];
            ps.idx = 0;
            ps.lastToKey = null;
            ps.stalledTicks = 0;
            ps.lastRecalc = 0;
        }

        const { to: repathTo } = pfStepToward(mem, purpose, creep, goalPos, pfRange, {
            maxRooms: 16,
            pathReuseTicks: 0,
            forceRecalc: true,
            roomCallback: pfRoomCallback
        });

        if (repathTo && isPassable(creep.room, repathTo, creep.id)) {
            logSolo(
                runtime,
                logEnabled,
                `planner: repath ok creep=${creep.name} to=${formatPos(repathTo)}`
            );
            return {
                moveTarget: { x: repathTo.x, y: repathTo.y, roomName: repathTo.roomName },
                range: 0,
                reason: 'pf:repath-injected'
            };
        }

        logSolo(
            runtime,
            logEnabled,
            `planner: repath failed creep=${creep.name} goal=${formatPos(goalPos)}`
        );

        // IMPORTANT:
        // We may have set ps.lastToKey during the (failed) repath attempt.
        // If we return HOLD without issuing a move, tickProgress will think we "stalled" forever
        // and keep injecting blocks each tick. Clear expectations on failure.
        if (ps) {
            ps.lastToKey = null;
            ps.stalledTicks = 0;
        }

        return {
            moveTarget: null,
            range: 0,
            reason: 'hold:blocked-no-alt'
        };
    }

    logSolo(
        runtime,
        logEnabled,
        `planner: step creep=${creep.name} from=${formatPos(creep.pos)} to=${formatPos(pfTo)} goal=${formatPos(goalPos)} purpose=${purpose}`
    );
    return {
        moveTarget: { x: pfTo.x, y: pfTo.y, roomName: pfTo.roomName },
        range: 0,
        reason: 'pf:step'
    };
}

module.exports = {
    plan
};
