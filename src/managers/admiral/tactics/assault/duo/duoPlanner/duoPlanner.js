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
const OPPOSITE_DIR = { 1: 5, 2: 6, 3: 7, 4: 8, 5: 1, 6: 2, 7: 3, 8: 4 };
const LEFT_DIR = { 1: 7, 2: 8, 3: 1, 4: 2, 5: 3, 6: 4, 7: 5, 8: 6 };
const RIGHT_DIR = { 1: 3, 2: 4, 3: 5, 4: 6, 5: 7, 6: 8, 7: 1, 8: 2 };

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

function pickLeaderDirsTowardGoal(leaderPos, goalPos) {
    if (!leaderPos || !goalPos) return [];
    const scored = [];
    for (const dir of DIRS) {
        const next = dirToPos(leaderPos, dir);
        if (!next) continue;
        const range = next.getRangeTo(goalPos);
        scored.push({ dir, next, range });
    }
    scored.sort((a, b) => a.range - b.range);
    return scored;
}

function pickLeaderDirsAlongBorder(leaderPos, borderAxis) {
    if (!leaderPos) return [];
    const scored = [];
    for (const dir of DIRS) {
        const next = dirToPos(leaderPos, dir);
        if (!next) continue;
        if (borderAxis === 'x' && next.x !== leaderPos.x) continue;
        if (borderAxis === 'y' && next.y !== leaderPos.y) continue;
        scored.push({ dir, next, range: 0 });
    }
    return scored;
}

function pickSupportOffsets(leaderDir, offset) {
    if (!leaderDir) return [];
    if (offset === 'left') return [LEFT_DIR[leaderDir]];
    if (offset === 'right') return [RIGHT_DIR[leaderDir]];
    if (offset === 'behind') return [OPPOSITE_DIR[leaderDir]];
    return [OPPOSITE_DIR[leaderDir], LEFT_DIR[leaderDir], RIGHT_DIR[leaderDir]];
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

function isPassableForCreep(room, pos, creep, movePlan) {
    if (!room || !pos) return false;
    const terrain = room.getTerrain().get(pos.x, pos.y);
    if (terrain === TERRAIN_MASK_WALL) return false;
    if (isClaimedByOther(movePlan, pos, creep)) return false;
    const creeps = room.lookForAt(LOOK_CREEPS, pos.x, pos.y);
    if (creeps && creeps.length > 0) {
        for (const other of creeps) {
            if (!creep || other.id !== creep.id) {
                if (allowedByVacating(movePlan, pos)) continue;
                return false;
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

function isGoalReached(leaderPos, goal) {
    if (!leaderPos || !goal || !goal.pos) return false;
    if (goal.type === 'OCCUPY') return isSamePos(leaderPos, goal.pos);
    const range = Number.isFinite(goal.range) ? goal.range : 1;
    return leaderPos.getRangeTo(goal.pos) <= range;
}

function computeSupportTo(room, leader, support, leaderTo, leaderDir, formation, movePlan) {
    if (!room || !leader || !support || !leaderTo) return null;
    const offset = formation && formation.supportOffset ? formation.supportOffset : 'auto';
    let preferredDirs = pickSupportOffsets(leaderDir, offset);
    if (offset === 'auto') {
        let passableAdj = 0;
        for (const dir of DIRS) {
            const pos = dirToPos(leaderTo, dir);
            if (!pos) continue;
            if (isPassableForSupport(room, pos, leader, support, movePlan)) passableAdj += 1;
        }
        if (passableAdj <= 2) {
            preferredDirs = [OPPOSITE_DIR[leaderDir]];
        }
    }
    for (const dir of preferredDirs) {
        const pos = dirToPos(leaderTo, dir);
        if (!pos) continue;
        if (!isPassableForSupport(room, pos, leader, support, movePlan)) continue;
        return pos;
    }
    const adjacent = getAdjacentTo(leaderTo);
    for (const pos of adjacent) {
        if (!isPassableForSupport(room, pos, leader, support, movePlan)) continue;
        return pos;
    }
    if (isSamePos(support.pos, leaderTo) && isPassableForSupport(room, support.pos, leader, support, movePlan)) {
        return support.pos;
    }
    return null;
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

function pickExitTile(room, toRoomName, referencePos) {
    if (!room || !toRoomName) return null;
    const exitDir = room.findExitTo(toRoomName);
    if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) return null;
    const exits = room.find(exitDir);
    if (!exits || exits.length === 0) return null;
    let best = exits[0];
    let bestRange = Infinity;
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

    for (const pos of exits) {
        const range = ref.getRangeTo(pos);
        if (range < bestRange) {
            bestRange = range;
            best = pos;
        }
    }
    return new RoomPosition(best.x, best.y, room.name);
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
    if (!Memory.duoPlanner) Memory.duoPlanner = {};
    if (!Memory.duoPlanner[memoryKey]) Memory.duoPlanner[memoryKey] = {};
    return Memory.duoPlanner[memoryKey];
}

function buildGoalKey(goalPos, goalType, goalRange) {
    return `${goalPos.roomName}:${goalPos.x}:${goalPos.y}:${goalType}:${goalRange}`;
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

        // If true, we’ll compute a full matrix even when runtimeCallback returns undefined.
        // If false, we only return a matrix when needed (preferRoads/considerCreeps/avoidBorders).
        alwaysBuild = false,
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
        if (!base) {
            const terrain = room.getTerrain();
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
                if (preferRoads) costs.set(x, y, roadCost);
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

            // Most other structures block movement
            costs.set(x, y, 255);
        }

        const sites = room.find(FIND_CONSTRUCTION_SITES);
        for (const cs of sites) {
            const x = cs.pos.x, y = cs.pos.y;

            // roads/containers/ramparts are OK; most other sites block
            if (cs.structureType === STRUCTURE_ROAD) {
                if (preferRoads) costs.set(x, y, roadCost);
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

                // Hard block is usually better for regroup.
                // If you prefer “squeeze around traffic” use e.g. 50 instead of 255.
                costs.set(c.pos.x, c.pos.y, 255);
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

function computeLeaderPath(leader, support, leaderPos, goalPos, goalType, goalRange, movement, runtime) {
    const range = goalType === 'RANGE' ? goalRange : 0;
    const roomCallback = buildRoomCallback(runtime && runtime.roomCallback, movement.preferRoads,{
                            considerCreeps: true,
                            ignoreCreepIds: buildIgnoreSet(leader, support),
                            avoidBorders: true,
                        });
    const result = PathFinder.search(
        leaderPos,
        { pos: goalPos, range },
        {
            maxRooms: 16,
            roomCallback
        }
    );
    return {
        path: result && result.path ? result.path : [],
        incomplete: !!(result && result.incomplete)
    };
}

function isExitTile(pos) {
  return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
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

    // If they would end on an exit tile without actually crossing, we must push inward.
    const needFixLeader = leaderEndsOnExit && !leaderCrossing;
    const needFixSupport = supportEndsOnExit && !supportCrossing;

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

function posOnEdge(pos, edge) {
  if (!pos) return false;
  if (edge === 'x0')  return pos.x === 0;
  if (edge === 'x49') return pos.x === 49;
  if (edge === 'y0')  return pos.y === 0;
  if (edge === 'y49') return pos.y === 49;
  return false;
}

function planSplitToGoalRoom(leader, support, goalPos, memory) {
    if (!leader || !support || !goalPos) return null;

    const leaderRoom = leader.room;
    const supportRoom = support.room;
    if (!leaderRoom || !supportRoom) return null;

    const goalRoomName = goalPos.roomName;

    const leaderInGoalRoom = leaderRoom.name === goalRoomName;
    const supportInGoalRoom = supportRoom.name === goalRoomName;

    // If one is already in the goal room, DO NOT pull it out to meet the other.
    // Instead: keep it moving toward goalPos (or holding), while the other crosses into goal room.
    if (leaderInGoalRoom && !supportInGoalRoom) {
        const supportExit = pickExitTile(supportRoom, goalRoomName, support.pos);
        if (!supportExit) return null;

        // leader goes toward goalPos (within its room)
        const leaderStepOptions = pickLeaderDirsTowardGoal(leader.pos, goalPos);
        let leaderTo = leader.pos, leaderDir = null;
        for (const opt of leaderStepOptions) {
            const cand = clampRoomPos(opt.next);
            if (!cand) continue;
            // ✅ split-mode rule: never "end" on border tiles (crossing must be explicit)
            if (isForbiddenSplitEnd(cand)) continue;
            const plan = buildMovePlan(leader, null, cand, null);
            if (!isPassableForCreep(leaderRoom, cand, leader, plan)) continue;
            leaderTo = cand; leaderDir = opt.dir; break;
        }

        // support goes toward exit into goal room
        const supportStepOptions = pickLeaderDirsTowardGoal(support.pos, supportExit);
        let supportTo = support.pos, supportDir = null;
        for (const opt of supportStepOptions) {
            const cand = clampRoomPos(opt.next);
            if (!cand) continue;
            // ✅ split-mode rule: never "end" on border tiles (crossing must be explicit)
            if (isForbiddenSplitEnd(cand,supportExit)) continue;
            const plan = buildMovePlan(null, support, null, cand);
            if (!isPassableForCreep(supportRoom, cand, support, plan)) continue;
            supportTo = cand; supportDir = opt.dir; break;
        }

        return { leaderDir, leaderTo, supportDir, supportTo };
    }

    if (supportInGoalRoom && !leaderInGoalRoom) {
        const leaderExit = pickExitTile(leaderRoom, goalRoomName, leader.pos);
        if (!leaderExit) return null;

        // support goes toward goalPos (within its room)
        const supportStepOptions = pickLeaderDirsTowardGoal(support.pos, goalPos);
        let supportTo = support.pos, supportDir = null;
        for (const opt of supportStepOptions) {
            const cand = clampRoomPos(opt.next);
            if (!cand) continue;
            // ✅ split-mode rule: never "end" on border tiles (crossing must be explicit)
            if (isForbiddenSplitEnd(cand)) continue;
            const plan = buildMovePlan(null, support, null, cand);
            if (!isPassableForCreep(supportRoom, cand, support, plan)) continue;
            supportTo = cand; supportDir = opt.dir; break;
        }

        // leader goes toward exit into goal room
        const leaderStepOptions = pickLeaderDirsTowardGoal(leader.pos, leaderExit);
        let leaderTo = leader.pos, leaderDir = null;
        for (const opt of leaderStepOptions) {
            const cand = clampRoomPos(opt.next);
            if (!cand) continue;
            // ✅ split-mode rule: never "end" on border tiles (crossing must be explicit)
            if (isForbiddenSplitEnd(cand,leaderExit)) continue;
            const plan = buildMovePlan(leader, null, cand, null);
            if (!isPassableForCreep(leaderRoom, cand, leader, plan)) continue;
            leaderTo = cand; leaderDir = opt.dir; break;
        }

        return { leaderDir, leaderTo, supportDir, supportTo };
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

function planSplitRegroup(leader, support, goalPos, memory) {
    if (!leader || !support) return null;
    const leaderRoom = leader.room;
    const supportRoom = support.room;
    if (!leaderRoom || !supportRoom) return null;

    let leaderExit = null;
    let supportExit = null;

    if (memory && memory.regroupLeaderExit && memory.regroupSupportExit) {
        const cachedLeader = deserializePos(memory.regroupLeaderExit);
        const cachedSupport = deserializePos(memory.regroupSupportExit);
        if (cachedLeader && cachedSupport && cachedLeader.roomName === leaderRoom.name && cachedSupport.roomName === supportRoom.name) {
            leaderExit = cachedLeader;
            supportExit = cachedSupport;
        }
    }

    if (!leaderExit || !supportExit) {
        const leaderRef = goalPos && goalPos.roomName === leaderRoom.name ? goalPos : support.pos;
        const supportRef = goalPos && goalPos.roomName === supportRoom.name ? goalPos : leader.pos;
        leaderExit = pickExitTile(leaderRoom, supportRoom.name, leaderRef);
        supportExit = pickExitTile(supportRoom, leaderRoom.name, supportRef);
        if (memory) {
            memory.regroupLeaderExit = serializePos(leaderExit);
            memory.regroupSupportExit = serializePos(supportExit);
        }
    }

    if (!leaderExit || !supportExit) return null;

    // === ADD THIS BLOCK HERE (after exits are known) ===
    const leaderOnExit = isSamePos(leader.pos, leaderExit);
    const supportOnExit = isSamePos(support.pos, supportExit);

    // If both are staged at their exits (typically split across the border),
    // commit in a leader-anchored way: leader HOLDS, support CROSSES into leader's room.
    // This prevents border stalemates and avoids ping-pong.
    if (leaderOnExit && supportOnExit) {

        // ✅ Determine which edge *should* lead from supportRoom -> leaderRoom
        const intendedExitDir = supportRoom.findExitTo(leaderRoom.name);
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
    // (We still let the other creep walk toward its exit.)
    // Note: returning here is fine because planSplitRegroup is only used when split rooms.
    if (leaderOnExit) {
        const supportStepOptions = pickLeaderDirsTowardGoal(support.pos, supportExit);
        let supportTo = support.pos;
        let supportDir = null;
        for (const option of supportStepOptions) {
            const candidate = clampRoomPos(option.next);
            if (!candidate) continue;
            if (isForbiddenSplitEnd(candidate, supportExit)) continue;   // ✅ NEW: never end on border in split mode
            const plan = buildMovePlan(null, support, null, candidate);
            if (!isPassableForCreep(supportRoom, candidate, support, plan)) continue;
            supportTo = candidate;
            supportDir = option.dir;
            break;
        }
        return { leaderDir: null, leaderTo: leader.pos, supportDir, supportTo };
    }

    if (supportOnExit) {
        const leaderStepOptions = pickLeaderDirsTowardGoal(leader.pos, leaderExit);
        let leaderTo = leader.pos;
        let leaderDir = null;
        for (const option of leaderStepOptions) {
            const candidate = clampRoomPos(option.next);
            if (!candidate) continue;
            if (isForbiddenSplitEnd(candidate,leaderExit)) continue;   // ✅ NEW: never end on border in split mode
            const plan = buildMovePlan(leader, null, candidate, null);
            if (!isPassableForCreep(leaderRoom, candidate, leader, plan)) continue;
            leaderTo = candidate;
            leaderDir = option.dir;
            break;
        }
        return { leaderDir, leaderTo, supportDir: null, supportTo: support.pos };
    }
    // === END ADD ===

    const leaderStepOptions = pickLeaderDirsTowardGoal(leader.pos, leaderExit);
    const supportStepOptions = pickLeaderDirsTowardGoal(support.pos, supportExit);
    let leaderTo = leader.pos;
    let leaderDir = null;
    let supportTo = support.pos;
    let supportDir = null;

    for (const option of leaderStepOptions) {
        const candidate = clampRoomPos(option.next);
        if (!candidate) continue;
        if (isForbiddenSplitEnd(candidate,leaderExit)) continue;   // ✅ NEW: never end on border in split mode
        const plan = buildMovePlan(leader, null, candidate, null);
        if (!isPassableForCreep(leaderRoom, candidate, leader, plan)) continue;
        leaderTo = candidate;
        leaderDir = option.dir;
        break;
    }

    for (const option of supportStepOptions) {
        const candidate = clampRoomPos(option.next);
        if (!candidate) continue;
        if (isForbiddenSplitEnd(candidate,supportExit)) continue;   // ✅ NEW: never end on border in split mode
        const plan = buildMovePlan(null, support, null, candidate);
        if (!isPassableForCreep(supportRoom, candidate, support, plan)) continue;
        supportTo = candidate;
        supportDir = option.dir;
        break;
    }

    return {
        leaderDir,
        supportDir,
        leaderTo,
        supportTo
    };
}

function planV2(request) {
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
    const pathReuseTicks = Number.isFinite(movement.pathReuseTicks) ? movement.pathReuseTicks : 25;
    const stallRepathTicks = Number.isFinite(movement.stallRepathTicks) ? movement.stallRepathTicks : 2;
    const runtime = req.runtime || null;
    const debug = !!req.debug;

    const cohesion = getCohesion(leader, support, cohesionRange);
    const sameRoom = cohesion.sameRoom;
    const dist = cohesion.dist;

    if (!leader || !support || !goalPos) {
        return {
            ok: false,
            reason: 'missing-input',
            mode: 'HOLD',
            cohesive: cohesion.cohesive,
            sameRoom,
            dist,
            step: applyBorderHygieneToStep(
                buildStepResult(leader, support, null, null),
                leader,
                support
            ),
            meta: {
                goalKey: goalPos ? buildGoalKey(goalPos, goalType, goalRange) : 'missing',
                usedPath: false,
                pathIndex: 0,
                stalledTicks: 0,
                allowFallbackMoveTo: false
            },
            debug: debug ? { reason: 'missing-input' } : undefined
        };
    }

    if (!sameRoom) {
        const memory = memoryKey ? getDuoMemory(memoryKey) : null;
        // NEW: if goalPos exists, converge into goal room instead of chasing each other
        const goalStep = planSplitToGoalRoom(leader, support, goalPos, memory);
        if (goalStep) {
            return {
                ok: true,
                reason: 'regroup-to-goal-room',
                mode: 'REGROUP',
                cohesive: false,
                sameRoom: false,
                dist,
                step: applyBorderHygieneToStep(
                    goalStep,
                    leader,
                    support
                ),
                meta: {
                    goalKey: buildGoalKey(goalPos, goalType, goalRange),
                    usedPath: false,
                    pathIndex: 0,
                    stalledTicks: 0,
                    allowFallbackMoveTo: false
                }
            };
        }

        const step = planSplitRegroup(leader, support, goalPos, memory);
        if (step) {
            return {
                ok: true,
                reason: 'regroup-split',
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
                    allowFallbackMoveTo: false
                },
                debug: debug ? { reason: 'split-rooms' } : undefined
            };
        }
        return {
            ok: false,
            reason: 'split-rooms',
            mode: 'REGROUP',
            cohesive: false,
            sameRoom: false,
            dist,
            step: applyBorderHygieneToStep(
                buildStepResult(leader, support, null, null),
                leader,
                support
            ),
            meta: {
                goalKey: buildGoalKey(goalPos, goalType, goalRange),
                usedPath: false,
                pathIndex: 0,
                stalledTicks: 0,
                allowFallbackMoveTo: false
            },
            debug: debug ? { reason: 'split-rooms' } : undefined
        };
    }

    const room = leader.room;
    if (!room || room.name !== support.room.name) {
        return {
            ok: false,
            reason: 'no-room',
            mode: 'HOLD',
            cohesive: cohesion.cohesive,
            sameRoom,
            dist,
            step: applyBorderHygieneToStep(
                buildStepResult(leader, support, null, null),
                leader,
                support
            ),
            meta: {
                goalKey: buildGoalKey(goalPos, goalType, goalRange),
                usedPath: false,
                pathIndex: 0,
                stalledTicks: 0,
                allowFallbackMoveTo: false
            }
        };
    }

    if (shouldHoldForFatigue(leader, support)) {
        return {
            ok: true,
            reason: 'fatigue',
            mode: cohesion.cohesive ? 'HOLD' : 'REGROUP',
            cohesive: cohesion.cohesive,
            sameRoom,
            dist,
            step: applyBorderHygieneToStep(
                buildStepResult(leader, support, leader.pos, support.pos),
                leader,
                support
            ),
            meta: {
                goalKey: buildGoalKey(goalPos, goalType, goalRange),
                usedPath: false,
                pathIndex: 0,
                stalledTicks: 0,
                allowFallbackMoveTo: false
            }
        };
    }

    if (!cohesion.cohesive && !allowSplit) {

        // === 1️⃣ Greedy regroup (must reduce distance) ===
        const supportDirs = pickLeaderDirsTowardGoal(support.pos, leader.pos);

        for (const option of supportDirs) {
            const supportTo = clampRoomPos(option.next);
            const planned = buildMovePlan(leader, support, leader.pos, supportTo);

            if (!isPassableForSupport(room, supportTo, leader, support, planned)) continue;

            const cur = leader.pos.getRangeTo(support.pos);
            const next = leader.pos.getRangeTo(supportTo);

            if (next >= cur) continue;

            return {
                ok: true,
                reason: 'regroup-support',
                mode: 'REGROUP',
                cohesive: false,
                sameRoom,
                dist,
                step: applyBorderHygieneToStep(
                    buildStepResult(leader, support, leader.pos, supportTo),
                    leader,
                    support
                ),
                meta: {
                    goalKey: buildGoalKey(goalPos, goalType, goalRange),
                    usedPath: false,
                    pathIndex: 0,
                    stalledTicks: 0,
                    allowFallbackMoveTo: false
                }
            };
        }

        // === 2️⃣ PathFinder fallback (detour allowed) ===
        // Build a "provisional" plan that represents our intent this tick:
        // leader holds, support will move somewhere (PF decides where).
        // This automatically marks leader/support current tiles as "vacating" IF they will move.
        // In this regroup case, leader holds (not vacating), support moves (support.pos becomes vacating)
        // NOTE: if you later allow leader to also move during regroup, this still works.
        const provisional = buildMovePlan(leader, support, leader.pos, support.pos);
        markVacating(provisional, support.pos);
        const roomCallback = buildRoomCallback(runtime && runtime.roomCallback, movement.preferRoads,{
                                considerCreeps: true,
                                ignoreCreepIds: buildIgnoreSet(leader, support),
                                vacatingPosKeys: provisional.vacating, // ✅ wire vacating into PF
                                avoidBorders: true,
                            });

        const pf = PathFinder.search(
            support.pos,
            { pos: leader.pos, range: 1 },
            { maxRooms: 1, roomCallback }
        );

        if (pf && pf.path && pf.path.length > 0) {
            const candidate = pf.path[0]; // first step

            // Now validate the candidate using your *real* same-tick collision rules.
            // This movePlan will mark support.pos as vacating (since support.pos -> candidate),
            // and will allow stepping into vacated tiles (including leader tile if it vacates).
            const planned = buildMovePlan(leader, support, leader.pos, candidate);

            if (isPassableForSupport(room, candidate, leader, support, planned)) {
                return {
                    ok: true,
                    reason: 'regroup-support-path',
                    mode: 'REGROUP',
                    cohesive: false,
                    sameRoom,
                    dist,
                    step: applyBorderHygieneToStep(
                        buildStepResult(leader, support, leader.pos, candidate),
                        leader,
                        support
                    ),
                    meta: {
                        goalKey: buildGoalKey(goalPos, goalType, goalRange),
                        usedPath: false,
                        pathIndex: 0,
                        stalledTicks: 0,
                        allowFallbackMoveTo: false
                    }
                };
            }
        }

        // === 3️⃣ Still blocked ===
        return {
            ok: false,
            reason: 'regroup-blocked',
            mode: 'REGROUP',
            cohesive: false,
            sameRoom,
            dist,
            step: applyBorderHygieneToStep(
                buildStepResult(leader, support, leader.pos, support.pos),
                leader,
                support
            ),
            meta: {
                goalKey: buildGoalKey(goalPos, goalType, goalRange),
                usedPath: false,
                pathIndex: 0,
                stalledTicks: 0,
                allowFallbackMoveTo: false
            }
        };
    }

    if (goalType === 'OCCUPY') {
        const hasCohesion = allowSplit ? true : leader.pos.getRangeTo(support.pos) <= cohesionRange;
        if (isSamePos(leader.pos, goalPos) && hasCohesion) {
            return {
                ok: true,
                reason: 'goal-occupy',
                mode: 'HOLD',
                cohesive: cohesion.cohesive,
                sameRoom,
                dist,
                step: applyBorderHygieneToStep(
                    buildStepResult(leader, support, leader.pos, support.pos),
                    leader,
                    support
                ),
                meta: {
                    goalKey: buildGoalKey(goalPos, goalType, goalRange),
                    usedPath: false,
                    pathIndex: 0,
                    stalledTicks: 0,
                    allowFallbackMoveTo: false
                }
            };
        }
    } else if (isGoalReached(leader.pos, { pos: goalPos, type: 'RANGE', range: goalRange })) {
        return {
            ok: true,
            reason: 'goal-reached',
            mode: 'HOLD',
            cohesive: cohesion.cohesive,
            sameRoom,
            dist,
            step: applyBorderHygieneToStep(
                buildStepResult(leader, support, leader.pos, support.pos),
                leader,
                support
            ),
            meta: {
                goalKey: buildGoalKey(goalPos, goalType, goalRange),
                usedPath: false,
                pathIndex: 0,
                stalledTicks: 0,
                allowFallbackMoveTo: false
            }
        };
    }

    const goalKey = buildGoalKey(goalPos, goalType, goalRange);
    const memory = memoryKey ? getDuoMemory(memoryKey) : null;
    if (memory) {
        if (memory.goalKey !== goalKey) {
            memory.goalKey = goalKey;
            memory.steps = null;
            memory.idx = 0;
            memory.lastRecalc = 0;
            memory.stalledTicks = 0;
            memory.lastLeaderToKey = null;
        }
    }

    if (goalPos.roomName !== room.name && isBorderPos(leader.pos)) {
        const crossDir = getBorderCrossDir(leader.pos);
        if (crossDir) {
            const supportTo = leader.pos;
            const movePlan = buildMovePlan(leader, support, leader.pos, supportTo);
            markVacating(movePlan, leader.pos);
            if (support.pos.getRangeTo(leader.pos) <= 1 && isPassableForSupport(room, supportTo, leader, support, movePlan)) {
                
                const rawStep = {
                    leaderDir: crossDir,                 // leader crosses
                    supportDir: support.pos.getDirectionTo(leader.pos), // will be overwritten by leader.pos target anyway
                    leaderTo: leader.pos,                // leader "to" stays; dir causes cross
                    supportTo: leader.pos                // ✅ support steps into leader's current tile (vacated this tick)
                };

                const safeStep = applyBorderHygieneToStep(rawStep, leader, support);
                return {
                    ok: true,
                    reason: 'border-handshake',
                    mode: 'BORDER_HANDSHAKE',
                    cohesive: true,
                    sameRoom,
                    dist,
                    step: safeStep,
                    meta: {
                        goalKey,
                        usedPath: false,
                        pathIndex: 0,
                        stalledTicks: memory ? (memory.stalledTicks || 0) : 0,
                        allowFallbackMoveTo: false
                    }
                };
            }
        }
    }

    let usedPath = false;
    let pathIndex = 0;
    let leaderCandidates = pickLeaderDirsTowardGoal(leader.pos, goalPos);
    if (goalPos.roomName !== room.name && isBorderPos(leader.pos)) {
        // If we're inter-room and already on border, do NOT force sideways motion.
        // Let the path / normal goal scoring decide, and rely on BORDER_HANDSHAKE or PRE-CROSS staging.
    }
    if (usePathCache && memory) {
        const now = Game.time;
        const shouldRecalc = !memory.steps || (pathReuseTicks > 0 && now - (memory.lastRecalc || 0) >= pathReuseTicks);
        if (shouldRecalc) {
            const result = computeLeaderPath(leader, support, leader.pos, goalPos, goalType, goalRange, movement, runtime);
            memory.steps = packDirections(result.path, leader.pos);
            memory.idx = 0;
            memory.lastRecalc = now;
            memory.stalledTicks = 0;
            memory.lastLeaderToKey = null;
        }

        if (Array.isArray(memory.steps) && memory.steps.length > 0) {
            if (memory.lastLeaderToKey && memory.lastLeaderToKey === posKey(leader.pos)) {
                memory.idx = Math.min((memory.idx || 0) + 1, memory.steps.length);
                memory.stalledTicks = 0;
            }
            const currentIdx = Number.isFinite(memory.idx) ? memory.idx : 0;
            const dir = memory.steps[currentIdx];
            if (dir) {
                const next = dirToPos(leader.pos, dir);
                if (next) {
                    const left = LEFT_DIR[dir];
                    const right = RIGHT_DIR[dir];

                    const leftPos = left ? dirToPos(leader.pos, left) : null;
                    const rightPos = right ? dirToPos(leader.pos, right) : null;

                    const candidates = [{ dir, next, range: next.getRangeTo(goalPos) }];

                    if (leftPos) candidates.push({ dir: left, next: leftPos, range: leftPos.getRangeTo(goalPos) });
                    if (rightPos) candidates.push({ dir: right, next: rightPos, range: rightPos.getRangeTo(goalPos) });

                    leaderCandidates = candidates;
                    usedPath = true;
                    pathIndex = currentIdx;
                }
            }
        }
    }

    // =====================
    // DEBUG: reject reasons
    // =====================
    const rejects = debug ? [] : null;

    function pushReject(option, why) {
        if (!rejects) return;
        if (rejects.length < 10) {
            rejects.push({
                dir: option.dir,
                next: option.next ? serializePos(option.next) : null,
                why
            });
        }
    }

    let blockedByCreepOnPath = false;
    let wantsCrossButNotReady = false;

    for (const option of leaderCandidates) {
        const leaderTo = clampRoomPos(option.next);
        if (!leaderTo) { pushReject(option, 'leaderTo-null'); continue; }

        const leaderDir = option.dir;

        const tentative = buildMovePlan(leader, support, leaderTo, support.pos);
        if (!isPassableForLeader(room, leaderTo, leader, support, tentative)) {
            // detect if blocked specifically by "some other creep" (not leader/support)
            const creeps = room.lookForAt(LOOK_CREEPS, leaderTo.x, leaderTo.y);
            const blockedByOtherCreep = creeps && creeps.some(c => c.id !== leader.id && c.id !== support.id);

            pushReject(option, blockedByOtherCreep ? 'leader-blocked-by-creep' : 'leader-not-passable');

            // only trigger instant repath when we're using cached path and the "primary" dir is blocked by creep
            if (usedPath && blockedByOtherCreep && option.dir === (memory && memory.steps ? memory.steps[pathIndex] : null)) {
                blockedByCreepOnPath = true;
            }
            continue;
        }

        const supportTo = computeSupportTo(room, leader, support, leaderTo, leaderDir, formation, tentative);
        if (!supportTo) { pushReject(option, 'support-null'); continue; }

        // PRE-CROSS STAGING: don't let leader step onto edge until support is ready to trail
        if (needsPreCrossStaging(room.name, goalPos, leaderTo)) {
            const supportReadyNow = support.pos.getRangeTo(leader.pos) <= 1;
            const supportTrailingThisTick = isSamePos(supportTo, leader.pos); // support steps into leader's vacated tile

            if (!(supportReadyNow && supportTrailingThisTick)) {
                wantsCrossButNotReady = true;
                pushReject(option, 'pre-cross-staging');
                continue;
            }
        }

        const movePlan = buildMovePlan(leader, support, leaderTo, supportTo);
        const canLeader = isPassableForLeader(room, leaderTo, leader, support, movePlan);
        const canSupport = isPassableForSupport(room, supportTo, leader, support, movePlan);
        if (!canLeader || !canSupport) {
            pushReject(option, !canLeader ? 'leader-not-passable-final' : 'support-not-passable-final');
            continue;
        }

        const swapAllowed = allowSwap && isSamePos(leaderTo, support.pos) && isSamePos(supportTo, leader.pos);
        if (!swapAllowed && isSamePos(leaderTo, supportTo)) { pushReject(option, 'same-tile'); continue; }

        if (!isCohesionOk(leaderTo, supportTo, cohesionRange, allowSplit)) {
            pushReject(option, 'cohesion-failed');
            continue;
        }

        if (goalType === 'OCCUPY' && isSamePos(leaderTo, goalPos)) {
            if (!isCohesionOk(leaderTo, supportTo, cohesionRange, allowSplit)) {
                pushReject(option, 'occupy-cohesion-failed');
                continue;
            }
        }

        if (memory && usedPath) {
            memory.lastLeaderToKey = posKey(leaderTo);
        }

        return {
            ok: true,
            reason: 'cohesive-step',
            mode: 'COHESIVE_TRAVEL',
            cohesive: true,
            sameRoom,
            dist,
            step: applyBorderHygieneToStep(
                buildStepResult(leader, support, leaderTo, supportTo),
                leader,
                support
            ),
            meta: {
                goalKey,
                usedPath,
                pathIndex,
                stalledTicks: memory ? (memory.stalledTicks || 0) : 0,
                allowFallbackMoveTo: false
            },
            debug: debug ? {
                leaderTo,
                supportTo,
                leaderDir,
                allowSwap,
                rejects // optional: shows rejects even on success (useful if you want)
            } : undefined
        };
    }

    if (usePathCache && memory && usedPath && blockedByCreepOnPath) {
        const now = Game.time;
        const result = computeLeaderPath(leader, support, leader.pos, goalPos, goalType, goalRange, movement, runtime);
        memory.steps = packDirections(result.path, leader.pos);
        memory.idx = 0;
        memory.lastRecalc = now;
        memory.stalledTicks = 0;
        memory.lastLeaderToKey = null;
    }

    if (usePathCache && memory && usedPath) {
        const now = Game.time;
        memory.stalledTicks = (memory.stalledTicks || 0) + 1;
        if (memory.stalledTicks >= stallRepathTicks) {
            const result = computeLeaderPath(leader, support, leader.pos, goalPos, goalType, goalRange, movement, runtime);
            memory.steps = packDirections(result.path, leader.pos);
            memory.idx = 0;
            memory.lastRecalc = now;
            memory.stalledTicks = 0;
            memory.lastLeaderToKey = null;
        }
    }

    // =========================================
    // PRE-CROSS SHIMMY: leader holds, support moves
    // =========================================
    if (wantsCrossButNotReady) {
        const supportDirs = pickLeaderDirsTowardGoal(support.pos, leader.pos);

        for (const option of supportDirs) {
            const supportTo = clampRoomPos(option.next);
            const movePlan = buildMovePlan(leader, support, leader.pos, supportTo);

            if (!isPassableForSupport(room, supportTo, leader, support, movePlan)) continue;

            const cur = leader.pos.getRangeTo(support.pos);
            const next = leader.pos.getRangeTo(supportTo);

            // must reduce distance
            if (next >= cur) continue;

            return {
                ok: true,
                reason: 'pre-cross-shimmy',
                mode: 'REGROUP',
                cohesive: false,
                sameRoom: true,
                dist,
                step: applyBorderHygieneToStep(
                    buildStepResult(leader, support, leader.pos, supportTo),
                    leader,
                    support
                ),
                meta: {
                    goalKey,
                    usedPath,
                    pathIndex,
                    stalledTicks: memory ? (memory.stalledTicks || 0) : 0,
                    allowFallbackMoveTo: false
                }
            };
        }
    }

    return {
        ok: false,
        reason: 'no-valid-step',
        mode: cohesion.cohesive ? 'HOLD' : 'REGROUP',
        cohesive: cohesion.cohesive,
        sameRoom,
        dist,
        step:  applyBorderHygieneToStep(
            buildStepResult(leader, support, leader.pos, support.pos),
            leader,
            support
        ),
        meta: {
            goalKey,
            usedPath,
            pathIndex,
            stalledTicks: memory ? (memory.stalledTicks || 0) : 0,
            allowFallbackMoveTo: false
        },
        debug: debug ? { reason: 'no-valid-step', rejects } : undefined
    };
}



module.exports = {
    plan: planV2
};
