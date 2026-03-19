const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');
const missionRuntime = require('managers_overseer_missions_board_missionRuntime');
const managerTerminal = require('managers_structures_manager.terminal');
const managerLabs = require('managers_structures_manager.labs');

const CORE_END_FLAG = 'CORE_END';
const CORE_LABS_FLAG = 'CORE_LABS';
const REBUILD_INTERVAL = 100;
const PLAIN_LANE_COST = 20;
const SWAMP_LANE_COST = 45;
const ROAD_BASE_COST = 4;
const ROAD_MAX_COVERAGE_BONUS = 3;
const MAX_ROUTE_WAYPOINT_CANDIDATES = 28;
const MAX_ROUTE_EVALUATIONS = 36;
const MAX_LOOP_WAYPOINTS = 8;
const LOOP_HEAD_END_RANGE = 3;
const LOOP_JOIN_MAX_SEGMENT_LENGTH = 6;
const CORE_LANE_DIRECT_TYPES = new Set([
    STRUCTURE_SPAWN,
    STRUCTURE_EXTENSION,
    STRUCTURE_TOWER,
    STRUCTURE_LAB,
    STRUCTURE_POWER_SPAWN,
    STRUCTURE_FACTORY,
    STRUCTURE_NUKER
]);
const CORE_SERVICE_JOB_PRIORITY = Object.freeze({
    [STRUCTURE_TOWER]: 98,
    [STRUCTURE_SPAWN]: 96,
    [STRUCTURE_EXTENSION]: 95,
    [STRUCTURE_LAB]: 86,
    [STRUCTURE_POWER_SPAWN]: 83,
    [STRUCTURE_FACTORY]: 80,
    [STRUCTURE_NUKER]: 78
});

function logLogisticsDebug(message) {
    if (typeof debug !== 'function') return;
    debug('mission.logistics', message);
}

function posKey(pos) {
    return pos ? `${pos.roomName}:${pos.x},${pos.y}` : '';
}

function clonePos(pos) {
    if (!pos) return null;
    return new RoomPosition(pos.x, pos.y, pos.roomName);
}

function cleanupAssigned(mission) {
    if (!mission.assigned) mission.assigned = { primary: [], support: [] };
    if (!Array.isArray(mission.assigned.primary)) mission.assigned.primary = [];
    mission.assigned.primary = mission.assigned.primary.filter(name => !!Game.creeps[name]);
}

function getCoreEndFlag(room) {
    if (!room) return null;
    const flag = Game.flags[CORE_END_FLAG];
    if (!flag) return null;
    if (!flag.pos || flag.pos.roomName !== room.name) return null;
    return flag;
}

function getCoreLabsFlag(room) {
    if (!room) return null;
    const flag = Game.flags[CORE_LABS_FLAG];
    if (!flag) return null;
    if (!flag.pos || flag.pos.roomName !== room.name) return null;
    return flag;
}

function getAdjacentRoadPos(room, originPos) {
    if (!room || !originPos) return null;
    const roads = room.lookForAtArea(
        LOOK_STRUCTURES,
        Math.max(0, originPos.y - 1),
        Math.max(0, originPos.x - 1),
        Math.min(49, originPos.y + 1),
        Math.min(49, originPos.x + 1),
        true
    );
    for (let i = 0; i < roads.length; i++) {
        const entry = roads[i];
        if (!entry || !entry.structure || entry.structure.structureType !== STRUCTURE_ROAD) continue;
        return new RoomPosition(entry.x, entry.y, room.name);
    }
    return null;
}

function getAdjacentRoadTiles(room, originPos) {
    if (!room || !originPos) return [];
    const roads = room.lookForAtArea(
        LOOK_STRUCTURES,
        Math.max(0, originPos.y - 1),
        Math.max(0, originPos.x - 1),
        Math.min(49, originPos.y + 1),
        Math.min(49, originPos.x + 1),
        true
    );
    const result = [];
    for (let i = 0; i < roads.length; i++) {
        const entry = roads[i];
        if (!entry || !entry.structure || entry.structure.structureType !== STRUCTURE_ROAD) continue;
        result.push(new RoomPosition(entry.x, entry.y, room.name));
    }
    return result;
}

function selectHeadAnchor(room, flag) {
    if (!room) return null;
    const spawns = room.find(FIND_MY_SPAWNS);
    if (!spawns || spawns.length <= 0) return null;

    if (room.storage) {
        // Priority: shared road tile adjacent to BOTH storage and at least one spawn.
        const storageRoads = getAdjacentRoadTiles(room, room.storage.pos);
        let bestSharedRoad = null;
        let bestSharedRange = Infinity;
        for (let i = 0; i < storageRoads.length; i++) {
            const tile = storageRoads[i];
            const nearSpawn = spawns.some(spawn => spawn && spawn.pos && tile.getRangeTo(spawn.pos) <= 1);
            if (!nearSpawn) continue;
            const rangeToEnd = flag ? tile.getRangeTo(flag.pos) : 0;
            if (rangeToEnd < bestSharedRange) {
                bestSharedRange = rangeToEnd;
                bestSharedRoad = tile;
            }
        }
        if (bestSharedRoad) {
            return {
                headPos: bestSharedRoad,
                headSourceId: room.storage.id
            };
        }

        const road = getAdjacentRoadPos(room, room.storage.pos);
        return {
            headPos: road || clonePos(room.storage.pos),
            headSourceId: room.storage.id
        };
    }

    let bestRoad = null;
    let bestRange = Infinity;
    for (let i = 0; i < spawns.length; i++) {
        const spawn = spawns[i];
        const road = getAdjacentRoadPos(room, spawn.pos);
        if (!road) continue;
        const range = flag ? road.getRangeTo(flag.pos) : 0;
        if (range < bestRange) {
            bestRange = range;
            bestRoad = { headPos: road, headSourceId: spawn.id };
        }
    }
    if (bestRoad) return bestRoad;
    return {
        headPos: clonePos(spawns[0].pos),
        headSourceId: spawns[0].id
    };
}

function isWalkableStructure(structure) {
    if (!structure) return true;
    const type = structure.structureType;
    if (type === STRUCTURE_ROAD) return true;
    if (type === STRUCTURE_CONTAINER) return true;
    if (type === STRUCTURE_RAMPART && (structure.my || structure.isPublic)) return true;
    return false;
}

function getCoreRefillTargets(room) {
    if (!room) return [];
    return room.find(FIND_MY_STRUCTURES, {
        filter: s => CORE_LANE_DIRECT_TYPES.has(s.structureType)
    });
}

function getCoreLaneTargets(room, hasLabsLane) {
    if (!room) return [];
    const excludeLabs = hasLabsLane === true;
    return room.find(FIND_MY_STRUCTURES, {
        filter: s =>
            CORE_LANE_DIRECT_TYPES.has(s.structureType) &&
            (!excludeLabs || s.structureType !== STRUCTURE_LAB)
    });
}

function getLabsLaneTargets(room) {
    if (!room) return [];
    return room.find(FIND_MY_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_LAB
    });
}

function getCoreServiceEnergyTargets(room, includeLabs) {
    if (!room) return [];
    const allowLabs = includeLabs !== false;
    return room.find(FIND_MY_STRUCTURES, {
        filter: s =>
            CORE_LANE_DIRECT_TYPES.has(s.structureType) &&
            (allowLabs || s.structureType !== STRUCTURE_LAB) &&
            s.store &&
            typeof s.store.getFreeCapacity === 'function' &&
            s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
    });
}

function countAdjacentTargets(pos, targets) {
    if (!pos || !Array.isArray(targets) || targets.length <= 0) return 0;
    let count = 0;
    for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        if (!target || !target.pos) continue;
        if (Math.abs(target.pos.x - pos.x) <= 1 && Math.abs(target.pos.y - pos.y) <= 1) count++;
    }
    return count;
}

function buildRoomCostMatrix(room, coreTargets, headPos, endPos) {
    const matrix = new PathFinder.CostMatrix();
    if (!room) return matrix;

    const terrain = room.getTerrain();
    for (let y = 0; y < 50; y++) {
        for (let x = 0; x < 50; x++) {
            const t = terrain.get(x, y);
            if (t === TERRAIN_MASK_WALL) {
                matrix.set(x, y, 255);
            } else if (t === TERRAIN_MASK_SWAMP) {
                matrix.set(x, y, SWAMP_LANE_COST);
            } else {
                matrix.set(x, y, PLAIN_LANE_COST);
            }
        }
    }

    const structures = room.find(FIND_STRUCTURES);
    for (let i = 0; i < structures.length; i++) {
        const s = structures[i];
        if (!s || !s.pos) continue;
        if (s.structureType === STRUCTURE_ROAD) {
            const adjacentTargetCount = countAdjacentTargets(s.pos, coreTargets);
            const coverageBonus = Math.min(ROAD_MAX_COVERAGE_BONUS, adjacentTargetCount);
            let roadCost = ROAD_BASE_COST - coverageBonus;
            if (headPos && s.pos.x === headPos.x && s.pos.y === headPos.y) roadCost = 1;
            if (endPos && s.pos.x === endPos.x && s.pos.y === endPos.y) roadCost = 1;
            matrix.set(s.pos.x, s.pos.y, Math.max(1, roadCost));
            continue;
        }
        if (!isWalkableStructure(s)) {
            matrix.set(s.pos.x, s.pos.y, 255);
        }
    }

    const sites = room.find(FIND_CONSTRUCTION_SITES);
    for (let i = 0; i < sites.length; i++) {
        const site = sites[i];
        if (!site || !site.pos) continue;
        if (site.structureType === STRUCTURE_ROAD || site.structureType === STRUCTURE_CONTAINER) continue;
        matrix.set(site.pos.x, site.pos.y, 255);
    }

    return matrix;
}

function searchPathSegment(room, startPos, endPos, costMatrix) {
    if (!room || !startPos || !endPos || !costMatrix) return null;
    const result = PathFinder.search(
        startPos,
        { pos: endPos, range: 0 },
        {
            maxOps: 4000,
            plainCost: PLAIN_LANE_COST,
            swampCost: SWAMP_LANE_COST,
            roomCallback: (roomName) => {
                if (roomName !== room.name) return false;
                return costMatrix;
            }
        }
    );
    if (!result || !Array.isArray(result.path) || result.path.length <= 0) return null;
    if (result.incomplete) return null;
    return result.path;
}

function buildPathData(path) {
    if (!Array.isArray(path) || path.length <= 0) return null;
    const indexByPos = Object.create(null);
    for (let i = 0; i < path.length; i++) {
        const key = posKey(path[i]);
        if (indexByPos[key] === undefined) indexByPos[key] = i;
    }
    return {
        path,
        indexByPos,
        pathLength: path.length
    };
}

function getRouteWaypointCandidates(room, coreTargets, headPos, endPos, limit) {
    if (!room || !Array.isArray(coreTargets) || coreTargets.length <= 0 || !headPos || !endPos) return [];
    const roads = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_ROAD });
    if (!roads || roads.length <= 0) return [];

    const keyed = [];
    for (let i = 0; i < roads.length; i++) {
        const road = roads[i];
        if (!road || !road.pos) continue;
        const adjacent = countAdjacentTargets(road.pos, coreTargets);
        if (adjacent <= 0) continue;
        keyed.push({
            pos: clonePos(road.pos),
            adjacent,
            rangeScore: road.pos.getRangeTo(headPos) + road.pos.getRangeTo(endPos)
        });
    }

    keyed.sort((a, b) => {
        if (a.adjacent !== b.adjacent) return b.adjacent - a.adjacent;
        return a.rangeScore - b.rangeScore;
    });

    const max = Math.max(1, Math.min(Number.isFinite(limit) ? limit : MAX_ROUTE_WAYPOINT_CANDIDATES, keyed.length));
    const out = [];
    const seen = Object.create(null);
    for (let i = 0; i < keyed.length && out.length < max; i++) {
        const candidate = keyed[i];
        const key = posKey(candidate.pos);
        if (!key || seen[key]) continue;
        if ((candidate.pos.x === headPos.x && candidate.pos.y === headPos.y) ||
            (candidate.pos.x === endPos.x && candidate.pos.y === endPos.y)) {
            continue;
        }
        seen[key] = true;
        out.push(candidate.pos);
    }
    return out;
}

function scorePathCoverage(path, coreTargets) {
    if (!Array.isArray(path) || path.length <= 0 || !Array.isArray(coreTargets) || coreTargets.length <= 0) {
        return { coveredCount: 0, coveredIds: [] };
    }
    const covered = new Set();
    for (let i = 0; i < coreTargets.length; i++) {
        const target = coreTargets[i];
        if (!target || !target.id || !target.pos) continue;
        for (let idx = 0; idx < path.length; idx++) {
            if (path[idx].getRangeTo(target.pos) <= 1) {
                covered.add(target.id);
                break;
            }
        }
    }
    return { coveredCount: covered.size, coveredIds: Array.from(covered) };
}

function pathHasRepeatedTiles(path) {
    if (!Array.isArray(path) || path.length <= 1) return false;
    const seen = Object.create(null);
    for (let i = 0; i < path.length; i++) {
        const key = posKey(path[i]);
        if (!key) continue;
        if (seen[key]) return true;
        seen[key] = true;
    }
    return false;
}

function shouldEvaluateLoopRoutes(headPos, endPos) {
    if (!headPos || !endPos) return false;
    return headPos.getRangeTo(endPos) <= LOOP_HEAD_END_RANGE;
}

function tryPromotePath(candidatePath, coreTargets, bestPath, bestScore) {
    if (!Array.isArray(candidatePath) || candidatePath.length <= 0) {
        return { bestPath, bestScore, changed: false };
    }
    if (pathHasRepeatedTiles(candidatePath)) {
        return { bestPath, bestScore, changed: false };
    }

    const score = scorePathCoverage(candidatePath, coreTargets);
    if (!Array.isArray(bestPath) || bestPath.length <= 0 || !bestScore) {
        return {
            bestPath: candidatePath,
            bestScore: score,
            changed: true
        };
    }
    const betterCoverage = score.coveredCount > bestScore.coveredCount;
    const equalCoverageShorter = score.coveredCount === bestScore.coveredCount &&
        candidatePath.length < bestPath.length;
    if (!betterCoverage && !equalCoverageShorter) {
        return { bestPath, bestScore, changed: false };
    }
    return {
        bestPath: candidatePath,
        bestScore: score,
        changed: true
    };
}

function buildLoopAugmentedPath(room, headPos, costMatrix, basePath, coreTargets) {
    if (!room || !headPos || !costMatrix || !Array.isArray(basePath) || basePath.length <= 0) return null;
    const tailPos = basePath[basePath.length - 1];
    if (!tailPos) return null;
    const tailRangeToHead = tailPos.getRangeTo(headPos);
    if (tailRangeToHead > LOOP_HEAD_END_RANGE) return null;

    const joinSegment = searchPathSegment(room, tailPos, headPos, costMatrix);
    if (!Array.isArray(joinSegment)) return null;
    if (joinSegment.length > LOOP_JOIN_MAX_SEGMENT_LENGTH) return null;

    // Keep path index mapping unambiguous by excluding the final head tile.
    const joinWithoutHead = joinSegment.slice(0, Math.max(0, joinSegment.length - 1));
    const candidatePath = basePath.concat(joinWithoutHead);
    if (pathHasRepeatedTiles(candidatePath)) return null;

    const score = scorePathCoverage(candidatePath, coreTargets);
    return {
        path: candidatePath,
        score,
        tailRangeToHead
    };
}

function buildPath(room, headPos, endPos, laneTargets) {
    if (!room || !headPos || !endPos) return null;
    if (headPos.roomName !== room.name || endPos.roomName !== room.name) return null;

    const coreTargets = Array.isArray(laneTargets) ? laneTargets : getCoreRefillTargets(room);
    const costMatrix = buildRoomCostMatrix(room, coreTargets, headPos, endPos);

    const direct = searchPathSegment(room, headPos, endPos, costMatrix);
    if (!direct) return null;
    const directPath = [clonePos(headPos)].concat(direct);
    const directScore = scorePathCoverage(directPath, coreTargets);
    const loopRouteEligible = shouldEvaluateLoopRoutes(headPos, endPos);

    let bestPath = loopRouteEligible ? null : directPath;
    let bestScore = loopRouteEligible ? null : directScore;
    let evaluations = 1;

    const waypointCandidates = getRouteWaypointCandidates(
        room,
        coreTargets,
        headPos,
        endPos,
        MAX_ROUTE_WAYPOINT_CANDIDATES
    );

    for (let i = 0; i < waypointCandidates.length; i++) {
        if (evaluations >= MAX_ROUTE_EVALUATIONS) break;
        const waypoint = waypointCandidates[i];
        if (!waypoint) continue;

        const firstSegment = searchPathSegment(room, headPos, waypoint, costMatrix);
        if (!firstSegment) continue;
        const secondSegment = searchPathSegment(room, waypoint, endPos, costMatrix);
        if (!secondSegment) continue;
        evaluations++;

        const candidatePath = [clonePos(headPos)].concat(firstSegment, secondSegment);
        const promoted = tryPromotePath(candidatePath, coreTargets, bestPath, bestScore);
        if (promoted.changed) {
            bestPath = promoted.bestPath;
            bestScore = promoted.bestScore;
        }
    }

    if (loopRouteEligible && evaluations < MAX_ROUTE_EVALUATIONS) {
        const loopCandidates = waypointCandidates.slice(0, Math.max(2, Math.min(MAX_LOOP_WAYPOINTS, waypointCandidates.length)));
        for (let i = 0; i < loopCandidates.length; i++) {
            if (evaluations >= MAX_ROUTE_EVALUATIONS) break;
            const firstWaypoint = loopCandidates[i];
            if (!firstWaypoint) continue;
            const firstSegment = searchPathSegment(room, headPos, firstWaypoint, costMatrix);
            if (!firstSegment) continue;

            for (let j = 0; j < loopCandidates.length; j++) {
                if (evaluations >= MAX_ROUTE_EVALUATIONS) break;
                if (i === j) continue;
                const secondWaypoint = loopCandidates[j];
                if (!secondWaypoint) continue;

                const middleSegment = searchPathSegment(room, firstWaypoint, secondWaypoint, costMatrix);
                if (!middleSegment) continue;
                const endSegment = searchPathSegment(room, secondWaypoint, endPos, costMatrix);
                if (!endSegment) continue;
                evaluations++;

                const candidatePath = [clonePos(headPos)].concat(firstSegment, middleSegment, endSegment);
                const promoted = tryPromotePath(candidatePath, coreTargets, bestPath, bestScore);
                if (promoted.changed) {
                    bestPath = promoted.bestPath;
                    bestScore = promoted.bestScore;
                }
            }
        }
    }
    if (loopRouteEligible) {
        if (!Array.isArray(bestPath) || bestPath.length <= 0) {
            bestPath = directPath;
            bestScore = directScore;
        } else if (!bestScore || bestScore.coveredCount < directScore.coveredCount) {
            bestPath = directPath;
            bestScore = directScore;
        }
    }

    let isLoop = false;
    const loopCandidate = buildLoopAugmentedPath(room, headPos, costMatrix, bestPath, coreTargets);
    if (loopCandidate) {
        // When join-to-head is viable, treat the lane as a full loop for index-based circulation.
        bestPath = loopCandidate.path;
        bestScore = loopCandidate.score;
        isLoop = true;
        logLogisticsDebug(
            `[LogisticsCoreV2] ${room.name} loop join accepted tailRange=${loopCandidate.tailRangeToHead} ` +
            `path=${loopCandidate.path.length} covered=${loopCandidate.score.coveredCount}`
        );
    } else if (loopRouteEligible) {
        logLogisticsDebug(
            `[LogisticsCoreV2] ${room.name} loop join unavailable head=${posKey(headPos)} end=${posKey(endPos)} ` +
            `bestPath=${bestPath.length} evals=${evaluations}`
        );
    }

    const built = buildPathData(bestPath);
    if (!built) return null;
    built.coveredTargetCount = bestScore.coveredCount;
    built.coveredTargetIds = bestScore.coveredIds;
    built.isLoop = isLoop;
    logLogisticsDebug(
        `[LogisticsCoreV2] ${room.name} path built loop=${isLoop ? 1 : 0} len=${built.pathLength} ` +
        `covered=${built.coveredTargetCount} evals=${evaluations} waypoints=${waypointCandidates.length}`
    );
    return built;
}

function buildStopsByIndex(room, path, laneTargets) {
    const stopsByIndex = Object.create(null);
    if (!room || !Array.isArray(path) || path.length <= 0) return stopsByIndex;

    const targets = Array.isArray(laneTargets)
        ? laneTargets.filter(s => s && s.store && typeof s.store.getFreeCapacity === 'function')
        : room.find(FIND_MY_STRUCTURES, {
            filter: s =>
                CORE_LANE_DIRECT_TYPES.has(s.structureType) &&
                s.store &&
                typeof s.store.getFreeCapacity === 'function'
        });

    for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        let bestIndex = -1;
        let bestRange = Infinity;

        for (let idx = 0; idx < path.length; idx++) {
            const tile = path[idx];
            const range = tile.getRangeTo(target.pos);
            if (range > 1) continue;
            if (range < bestRange) {
                bestRange = range;
                bestIndex = idx;
            }
        }

        if (bestIndex < 0) continue;
        if (!stopsByIndex[bestIndex]) stopsByIndex[bestIndex] = [];
        stopsByIndex[bestIndex].push(target.id);
    }

    return stopsByIndex;
}

function findNearestPathIndex(path, pos, preferRangeOne) {
    if (!Array.isArray(path) || path.length <= 0 || !pos) return -1;
    let bestIndex = -1;
    let bestRange = Infinity;
    for (let i = 0; i < path.length; i++) {
        const tile = path[i];
        const range = tile.getRangeTo(pos);
        if (preferRangeOne && range > 1) continue;
        if (range < bestRange) {
            bestRange = range;
            bestIndex = i;
            if (bestRange <= 0) break;
        }
    }
    if (bestIndex >= 0) return bestIndex;
    if (!preferRangeOne) return -1;
    return findNearestPathIndex(path, pos, false);
}

function getNearestPathInfo(path, pos) {
    if (!Array.isArray(path) || path.length <= 0 || !pos) return { index: -1, range: Infinity };
    let bestIndex = -1;
    let bestRange = Infinity;
    for (let i = 0; i < path.length; i++) {
        const tile = path[i];
        const range = tile.getRangeTo(pos);
        if (range < bestRange) {
            bestRange = range;
            bestIndex = i;
            if (bestRange <= 0) break;
        }
    }
    return { index: bestIndex, range: bestRange };
}

function findNearestPathIndexExcluding(path, pos, excludedIndex) {
    if (!Array.isArray(path) || path.length <= 1 || !pos) return -1;
    let bestIndex = -1;
    let bestRange = Infinity;
    for (let i = 0; i < path.length; i++) {
        if (i === excludedIndex) continue;
        const tile = path[i];
        const range = tile.getRangeTo(pos);
        if (range < bestRange) {
            bestRange = range;
            bestIndex = i;
            if (bestRange <= 0) break;
        }
    }
    return bestIndex;
}

function clampNumber(value, fallback, min, max) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    const lo = Number.isFinite(min) ? min : -Infinity;
    const hi = Number.isFinite(max) ? max : Infinity;
    if (num < lo) return lo;
    if (num > hi) return hi;
    return num;
}

function getStoreAmount(obj, resourceType) {
    if (!obj || !resourceType) return 0;
    if (obj.store) return obj.store[resourceType] || 0;
    if (obj.resourceType === resourceType && Number.isFinite(obj.amount)) return obj.amount;
    return 0;
}

function getTerminalStockJobs(room) {
    if (!room || !room.storage || !room.terminal) return [];
    const storage = room.storage;
    const terminal = room.terminal;
    if (!storage.store || !terminal.store) return [];

    const targets = (managerTerminal && typeof managerTerminal.getTerminalStockTargets === 'function')
        ? (managerTerminal.getTerminalStockTargets(room.name) || {})
        : {};
    const jobs = [];
    const seen = new Set();
    const keys = new Set();
    Object.keys(targets).forEach(k => keys.add(k));
    Object.keys(terminal.store || {}).forEach(k => keys.add(k));

    keys.forEach(resourceType => {
        if (!resourceType || resourceType === RESOURCE_ENERGY) return;
        const target = Number(targets[resourceType] || 0);
        const termAmt = terminal.store[resourceType] || 0;

        if (target > 0) {
            const deadband = clampNumber(Math.ceil(target * 0.05), 50, 50, 2000);
            const lo = Math.max(0, target - deadband);
            const hi = target + deadband;

            if (termAmt < lo) {
                const storageAmt = storage.store[resourceType] || 0;
                const need = Math.min(target - termAmt, storageAmt);
                if (need > 0) {
                    const id = `stock:${storage.id}:${terminal.id}:${resourceType}`;
                    if (!seen.has(id)) {
                        seen.add(id);
                        jobs.push({
                            id,
                            kind: 'stock',
                            sourceId: storage.id,
                            targetId: terminal.id,
                            resourceType,
                            amountHint: need,
                            pathKey: 'core',
                            priority: 60
                        });
                    }
                }
                return;
            }

            if (termAmt > hi) {
                const storageFree = storage.store.getFreeCapacity(resourceType) || 0;
                const excess = Math.min(termAmt - target, storageFree);
                if (excess > 0) {
                    const id = `stock:${terminal.id}:${storage.id}:${resourceType}`;
                    if (!seen.has(id)) {
                        seen.add(id);
                        jobs.push({
                            id,
                            kind: 'stock',
                            sourceId: terminal.id,
                            targetId: storage.id,
                            resourceType,
                            amountHint: excess,
                            pathKey: 'core',
                            priority: 60
                        });
                    }
                }
            }
            return;
        }

        if (termAmt > 0) {
            const storageFree = storage.store.getFreeCapacity(resourceType) || 0;
            const flushAll = Math.min(termAmt, storageFree);
            if (flushAll > 0) {
                const id = `stock:${terminal.id}:${storage.id}:${resourceType}`;
                if (!seen.has(id)) {
                    seen.add(id);
                    jobs.push({
                        id,
                        kind: 'stock',
                        sourceId: terminal.id,
                        targetId: storage.id,
                        resourceType,
                        amountHint: flushAll,
                        pathKey: 'core',
                        priority: 60
                    });
                }
            }
        }
    });

    return jobs;
}

function getLabHaulJobs(room, includeEnergyNeeds) {
    if (!room || !managerLabs) return [];

    const needs = (typeof managerLabs.getLogisticsNeeds === 'function')
        ? managerLabs.getLogisticsNeeds(room, { includeEnergy: includeEnergyNeeds === true })
        : [];
    if (!Array.isArray(needs) || needs.length <= 0) return [];

    const jobs = [];
    for (let i = 0; i < needs.length; i++) {
        const need = needs[i];
        if (!need || need.type !== 'transfer') continue;
        const resourceType = need.resourceType || null;
        const targetId = need.targetId || null;
        const sourceId = need.sourceId || null;
        if (!resourceType || !targetId || !sourceId) continue;
        const operation = need.operation || 'transfer';
        const basePriority = Number.isFinite(need.priority) ? need.priority : 60;
        const isClearOp = (
            operation === 'clear' ||
            operation === 'reverse_clear' ||
            operation === 'reverse_clearCompound'
        );
        // In idle/purge flows, clear ops should win over energy fills so labs are emptied promptly.
        const priority = isClearOp ? Math.max(basePriority, 90) : basePriority;

        jobs.push({
            id: need.id || `labhaul:${sourceId}:${targetId}:${resourceType}:${i}`,
            kind: 'labs',
            sourceId,
            targetId,
            resourceType,
            pathKey: 'labs',
            priority,
            operation
        });
    }
    return jobs;
}

function getCoreServiceEnergyJobs(room, runtime, sourceId, includeLabs) {
    if (!room || !runtime || !runtime.paths || !runtime.paths.core) return [];
    const corePath = runtime.paths.core.path;
    if (!Array.isArray(corePath) || corePath.length <= 0) return [];

    let actualSourceId = sourceId || null;
    let source = actualSourceId ? Game.getObjectById(actualSourceId) : null;
    if ((!source || !source.store) && room.storage) {
        source = room.storage;
        actualSourceId = room.storage.id;
    }
    if ((!source || !source.store) && room.terminal) {
        source = room.terminal;
        actualSourceId = room.terminal.id;
    }
    if (!source || !source.store || !actualSourceId) return [];

    const sourceInfo = getNearestPathInfo(corePath, source.pos);
    if (sourceInfo.index < 0) return [];

    const targets = getCoreServiceEnergyTargets(room, includeLabs);
    const jobs = [];
    const seen = new Set();
    for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        if (!target || !target.id || !target.pos || !target.store) continue;
        if (target.id === actualSourceId) continue;
        const need = target.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
        if (need <= 0) continue;

        const adjacentIndex = findNearestPathIndex(corePath, target.pos, true);
        // Adjacent targets are handled by on-lane transfer stops.
        if (adjacentIndex >= 0) continue;

        const nearest = getNearestPathInfo(corePath, target.pos);
        if (nearest.index < 0) continue;
        const id = `coreService:${actualSourceId}:${target.id}:${RESOURCE_ENERGY}`;
        if (seen.has(id)) continue;
        seen.add(id);
        jobs.push({
            id,
            kind: 'core_service',
            sourceId: actualSourceId,
            targetId: target.id,
            resourceType: RESOURCE_ENERGY,
            amountHint: need,
            priority: CORE_SERVICE_JOB_PRIORITY[target.structureType] || 82,
            pathKey: 'core',
            sourceIndex: sourceInfo.index,
            targetIndex: nearest.index
        });
    }
    return jobs;
}

function shouldActivate(room) {
    if (!room || !room.controller || !room.controller.my) return false;
    const spawns = room.find(FIND_MY_SPAWNS);
    if (!spawns || spawns.length <= 0) return false;
    if (!room.storage && spawns.length <= 0) return false;
    if (!getCoreEndFlag(room)) return false;
    return true;
}

function getAssignedCoreLaneCreeps(missionId, roomName) {
    const assigned = [];
    for (const name in Game.creeps) {
        const creep = Game.creeps[name];
        if (!creep || !creep.my || !creep.memory) continue;
        if (creep.memory.missionType !== 'logisticsCoreV2') continue;
        if (creep.memory.coreLaneMissionId !== missionId && creep.memory.missionId !== missionId) continue;
        if (roomName && creep.memory.room && creep.memory.room !== roomName) continue;
        assigned.push(creep.name);
    }
    return assigned;
}

function getEstimatedCarryPartsPerHauler(room) {
    if (!room) return 3;
    const cap = Math.max(300, room.energyCapacityAvailable || 300);
    return Math.max(2, Math.min(25, Math.floor(cap / 100)));
}

function getAssignedCarryParts(names) {
    if (!Array.isArray(names) || names.length <= 0) return 0;
    let total = 0;
    for (let i = 0; i < names.length; i++) {
        const creep = Game.creeps[names[i]];
        if (!creep || !creep.my) continue;
        total += creep.getActiveBodyparts(CARRY);
    }
    return total;
}

function countCoreStops(stopsByIndex) {
    if (!stopsByIndex) return 0;
    let total = 0;
    for (const idxKey in stopsByIndex) {
        const stopIds = stopsByIndex[idxKey];
        if (!Array.isArray(stopIds)) continue;
        total += stopIds.length;
    }
    return total;
}

function countServicePoints(room, laneJobs) {
    const points = new Set();
    if (room && room.storage && room.storage.id) points.add(room.storage.id);
    if (room && room.terminal && room.terminal.id) points.add(room.terminal.id);
    if (room) {
        const labs = room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_LAB });
        for (let i = 0; i < labs.length; i++) {
            if (labs[i] && labs[i].id) points.add(labs[i].id);
        }
    }
    if (Array.isArray(laneJobs)) {
        for (let i = 0; i < laneJobs.length; i++) {
            const job = laneJobs[i];
            if (!job) continue;
            if (job.sourceId) points.add(job.sourceId);
            if (job.targetId) points.add(job.targetId);
        }
    }
    return points.size;
}

function estimateCarryPartsNeeded(corePathLength, coreStopCount, labsPathLength, servicePointCount) {
    const coreTravelWeight = Math.ceil(Math.max(1, corePathLength || 0) / 3);
    const coreStopWeight = Math.ceil(Math.max(1, coreStopCount || 0) / 8);
    const labsTravelWeight = labsPathLength > 0 ? Math.ceil(labsPathLength / 14) : 0;
    const serviceWeight = Math.ceil(Math.max(0, servicePointCount || 0) / 3);
    return Math.max(1, coreTravelWeight + coreStopWeight + labsTravelWeight + serviceWeight);
}

function computeBaselineFleetPlan(room, runtime, laneJobs) {
    const corePathLength = runtime && runtime.paths && runtime.paths.core ? (runtime.paths.core.pathLength || 0) : 0;
    const labsPathLength = runtime && runtime.paths && runtime.paths.labs ? (runtime.paths.labs.pathLength || 0) : 0;
    const coreStopCount = runtime && runtime.paths && runtime.paths.core
        ? countCoreStops(runtime.paths.core.stopsByIndex)
        : 0;
    const servicePointCount = countServicePoints(room, laneJobs);
    const neededCarryParts = estimateCarryPartsNeeded(
        corePathLength,
        coreStopCount,
        labsPathLength,
        servicePointCount
    );
    return {
        corePathLength,
        labsPathLength,
        coreStopCount,
        servicePointCount,
        neededCarryParts
    };
}

function computeOutstandingLaneJobs(laneJobs) {
    if (!Array.isArray(laneJobs) || laneJobs.length <= 0) return 0;
    let total = 0;
    for (let i = 0; i < laneJobs.length; i++) {
        const job = laneJobs[i];
        if (!job || !job.resourceType) continue;
        const source = job.sourceId ? Game.getObjectById(job.sourceId) : null;
        const target = job.targetId ? Game.getObjectById(job.targetId) : null;
        if (!source || !target || !source.store || !target.store) continue;
        const available = getStoreAmount(source, job.resourceType);
        const free = target.store.getFreeCapacity(job.resourceType) || 0;
        if (available <= 0 || free <= 0) continue;
        const hinted = Number.isFinite(job.amountHint) ? Math.max(0, Math.floor(job.amountHint)) : Infinity;
        total += Math.min(available, free, hinted);
    }
    return total;
}

module.exports = {
    makeKey(context) {
        return missionKeys.makeUserMissionKey(
            context.targetRoom || context.sponsorRoom,
            'logisticsCoreV2',
            'coreLane'
        );
    },

    reconcileRoom({ room, intel, context, missionBoard }) {
        if (!room || !intel || !missionBoard) return;
        if (!missionThrottle.shouldRunReconcile('logisticsCoreV2', room.name, Game.time)) return;
        if (!shouldActivate(room)) return;

        missionBoard.createMission('logisticsCoreV2', {
            sponsorRoom: room.name,
            targetRoom: room.name,
            priority: 92
        }, { room, intel, context });
    },

    create(context) {
        const now = Game.time;
        const key = this.makeKey(context);
        return {
            id: key,
            key,
            type: 'logisticsCoreV2',
            class: missionClasses.SERVICE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.targetRoom || context.sponsorRoom,
            priority: Number.isFinite(context.priority) ? context.priority : 92,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: null,
            assigned: { primary: [], support: [] },
            demand: { role: 'coreLaneHauler', count: 1, bodyProfile: 'hauler' },
            goal: {
                kind: 'service',
                target: { kind: 'logistics_core_lane', roomName: context.targetRoom || context.sponsorRoom },
                success: { kind: 'lane_refill_active' },
                completion: 'never'
            },
            progress: {
                stage: 'core_lane',
                goalState: 'seeking_assignment',
                pathLength: 0,
                assignedPrimary: 0
            },
            meta: {
                missionName: `logistics:coreV2:${context.targetRoom || context.sponsorRoom}`,
                endFlagName: CORE_END_FLAG,
                labsFlagName: CORE_LABS_FLAG,
                desiredCount: 1,
                headSourceId: null
            },
            statusReason: null
        };
    },

    validate(mission, runtimeCtx) {
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        return shouldActivate(room);
    },

    refresh(mission, runtimeCtx) {
        cleanupAssigned(mission);

        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        if (!shouldActivate(room)) return;

        const flag = getCoreEndFlag(room);
        const anchor = selectHeadAnchor(room, flag);
        if (!flag || !anchor || !anchor.headPos) return;

        const runtime = missionRuntime.getMissionRuntime(mission);
        const headPos = anchor.headPos;
        const coreEndPos = clonePos(flag.pos);
        const labsFlag = getCoreLabsFlag(room);
        const labsEndPos = labsFlag ? clonePos(labsFlag.pos) : null;
        const hasLabsLane = !!labsEndPos;
        const coreLaneTargets = getCoreLaneTargets(room, hasLabsLane);
        const labsLaneTargets = hasLabsLane ? getLabsLaneTargets(room) : [];
        const headKey = posKey(headPos);
        const coreEndKey = posKey(coreEndPos);
        const labsEndKey = posKey(labsEndPos);
        if (!runtime.paths) runtime.paths = {};
        const buildInputsChanged =
            runtime.headKey !== headKey ||
            runtime.coreEndKey !== coreEndKey ||
            runtime.labsEndKey !== labsEndKey;
        const rebuildIntervalElapsed =
            !Number.isFinite(runtime.lastBuiltTick) ||
            (Game.time - runtime.lastBuiltTick) >= REBUILD_INTERVAL;
        // Retry cadence is interval-based so failed builds do not trigger pathfinding every tick.
        const shouldRebuild = buildInputsChanged || rebuildIntervalElapsed;

        if (shouldRebuild) {
            const builtCore = buildPath(room, headPos, coreEndPos, coreLaneTargets);
            if (builtCore) {
                runtime.paths.core = {
                    path: builtCore.path,
                    indexByPos: builtCore.indexByPos,
                    pathLength: builtCore.pathLength,
                    coveredTargetCount: Number.isFinite(builtCore.coveredTargetCount) ? builtCore.coveredTargetCount : 0,
                    isLoop: builtCore.isLoop === true,
                    headPos: clonePos(headPos),
                    endPos: clonePos(coreEndPos),
                    stopsByIndex: buildStopsByIndex(room, builtCore.path, coreLaneTargets)
                };
                logLogisticsDebug(
                    `[LogisticsCoreV2] ${room.name} rebuild core loop=${runtime.paths.core.isLoop ? 1 : 0} ` +
                    `len=${runtime.paths.core.pathLength} covered=${runtime.paths.core.coveredTargetCount} ` +
                    `head=${headKey} end=${coreEndKey}`
                );
            } else {
                logLogisticsDebug(
                    `[LogisticsCoreV2] ${room.name} rebuild core failed head=${headKey} end=${coreEndKey} ` +
                    `targets=${coreLaneTargets.length}`
                );
            }

            if (labsEndPos) {
                const builtLabs = buildPath(room, headPos, labsEndPos, labsLaneTargets);
                if (builtLabs) {
                    runtime.paths.labs = {
                        path: builtLabs.path,
                        indexByPos: builtLabs.indexByPos,
                        pathLength: builtLabs.pathLength,
                        headPos: clonePos(headPos),
                        endPos: clonePos(labsEndPos),
                        stopsByIndex: Object.create(null)
                    };
                } else {
                    delete runtime.paths.labs;
                }
            } else {
                delete runtime.paths.labs;
            }

            runtime.headSourceId = anchor.headSourceId || null;
            runtime.headKey = headKey;
            runtime.coreEndKey = coreEndKey;
            runtime.labsEndKey = labsEndKey;
            runtime.lastBuiltTick = Game.time;
        }

        // Keep lane stops current even when path does not rebuild.
        if (runtime.paths && runtime.paths.core && Array.isArray(runtime.paths.core.path)) {
            runtime.paths.core.stopsByIndex = buildStopsByIndex(room, runtime.paths.core.path, coreLaneTargets);
        }

        const labsPath = runtime.paths && runtime.paths.labs ? runtime.paths.labs.path : null;
        let coreJobSourceId = runtime.headSourceId || anchor.headSourceId || null;
        const coreJobSourceObj = coreJobSourceId ? Game.getObjectById(coreJobSourceId) : null;
        if (coreJobSourceObj && coreJobSourceObj.structureType === STRUCTURE_SPAWN && room.storage) {
            coreJobSourceId = room.storage.id;
        }
        if (!coreJobSourceId && room.storage) coreJobSourceId = room.storage.id;
        const stockJobs = getTerminalStockJobs(room);
        const labJobs = getLabHaulJobs(room, hasLabsLane);
        const coreServiceJobs = getCoreServiceEnergyJobs(room, runtime, coreJobSourceId, !hasLabsLane);
        const jobs = coreServiceJobs.concat(stockJobs, labJobs);
        const jobsById = Object.create(null);
        const laneJobs = [];
        for (let i = 0; i < jobs.length; i++) {
            const job = jobs[i];
            if (!job || !job.id || jobsById[job.id]) continue;
            const source = job.sourceId ? Game.getObjectById(job.sourceId) : null;
            const target = job.targetId ? Game.getObjectById(job.targetId) : null;
            if (!source || !target || !source.pos || !target.pos) continue;
            if (!source.store || !target.store) continue;
            const amount = getStoreAmount(source, job.resourceType);
            if (amount <= 0) continue;
            if (target.store.getFreeCapacity(job.resourceType) <= 0) continue;

            let pathKey = job.pathKey || ((labsPath && labsPath.length > 0) ? 'labs' : 'core');
            let path = pathKey === 'labs' ? labsPath : (runtime.paths.core && runtime.paths.core.path);
            if ((!Array.isArray(path) || path.length <= 0) && pathKey !== 'core') {
                pathKey = 'core';
                path = runtime.paths.core && runtime.paths.core.path;
            }
            if (!Array.isArray(path) || path.length <= 0) continue;

            let sourceIndex = Number.isInteger(job.sourceIndex)
                ? job.sourceIndex
                : findNearestPathIndex(path, source.pos, true);
            let targetIndex = Number.isInteger(job.targetIndex)
                ? job.targetIndex
                : findNearestPathIndex(path, target.pos, true);
            if (sourceIndex < 0 || targetIndex < 0) continue;

            if (sourceIndex === targetIndex && path.length > 1) {
                const targetAlt = findNearestPathIndexExcluding(path, target.pos, sourceIndex);
                if (targetAlt >= 0) {
                    targetIndex = targetAlt;
                } else {
                    const sourceAlt = findNearestPathIndexExcluding(path, source.pos, targetIndex);
                    if (sourceAlt >= 0) sourceIndex = sourceAlt;
                }
                if (sourceIndex === targetIndex) {
                    logLogisticsDebug(
                        `[LogisticsCoreV2] ${room.name} drop degenerate job id=${job.id} path=${pathKey} idx=${sourceIndex}`
                    );
                    continue;
                }
                logLogisticsDebug(
                    `[LogisticsCoreV2] ${room.name} adjust job indices id=${job.id} path=${pathKey} ` +
                    `source=${sourceIndex} target=${targetIndex}`
                );
            }

            const item = {
                id: job.id,
                kind: job.kind || 'stock',
                sourceId: job.sourceId,
                targetId: job.targetId,
                resourceType: job.resourceType || RESOURCE_ENERGY,
                amountHint: Number.isFinite(job.amountHint) ? Math.max(0, Math.floor(job.amountHint)) : null,
                priority: Number.isFinite(job.priority) ? job.priority : 60,
                operation: job.operation || null,
                pathKey,
                sourceIndex,
                targetIndex
            };
            laneJobs.push(item);
            jobsById[item.id] = item;
        }
        laneJobs.sort((a, b) => {
            const ap = Number.isFinite(a.priority) ? a.priority : 0;
            const bp = Number.isFinite(b.priority) ? b.priority : 0;
            if (ap !== bp) return bp - ap;
            return a.id.localeCompare(b.id);
        });
        runtime.laneJobs = laneJobs;
        runtime.laneJobsById = jobsById;

        runtime.assignedCreeps = getAssignedCoreLaneCreeps(mission.id, room.name);
        mission.assigned.primary = runtime.assignedCreeps.slice();
        const assignedCarryParts = getAssignedCarryParts(mission.assigned.primary);
        const basePlan = computeBaselineFleetPlan(room, runtime, laneJobs);
        const neededCarryParts = basePlan.neededCarryParts;
        const desiredCount = 1;
        mission.meta.headSourceId = runtime.headSourceId || anchor.headSourceId || null;
        if (!mission.meta.missionName) {
            mission.meta.missionName = `logistics:coreV2:${mission.targetRoom || mission.sponsorRoom}`;
        }
        mission.meta.desiredCount = desiredCount;
        mission.meta.intendedCarryParts = getEstimatedCarryPartsPerHauler(room);
        mission.meta.neededCarryParts = neededCarryParts;
        mission.meta.assignedCarryParts = assignedCarryParts;
        mission.requirements = {
            archetype: 'coreLaneHauler',
            minCount: desiredCount,
            maxCount: desiredCount,
            requiredCarry: neededCarryParts,
            spawn: true,
            spawnFromFleet: false
        };
        mission.demand = {
            role: 'coreLaneHauler',
            count: Math.max(0, desiredCount - mission.assigned.primary.length),
            bodyProfile: 'hauler'
        };
        mission.progress = mission.progress || {};
        mission.progress.stage = 'core_lane';
        mission.progress.goalState = mission.assigned.primary.length > 0 ? 'sustaining' : 'seeking_assignment';
        mission.progress.pathLength = runtime.paths && runtime.paths.core && Number.isFinite(runtime.paths.core.pathLength)
            ? runtime.paths.core.pathLength
            : 0;
        mission.progress.coveredCoreTargets = runtime.paths && runtime.paths.core && Number.isFinite(runtime.paths.core.coveredTargetCount)
            ? runtime.paths.core.coveredTargetCount
            : 0;
        mission.progress.labsPathLength = runtime.paths && runtime.paths.labs && Number.isFinite(runtime.paths.labs.pathLength)
            ? runtime.paths.labs.pathLength
            : 0;
        mission.progress.labsJobs = Array.isArray(runtime.laneJobs) ? runtime.laneJobs.length : 0;
        mission.progress.coreStopCount = basePlan.coreStopCount;
        mission.progress.servicePointCount = basePlan.servicePointCount;
        mission.progress.jobsOutstanding = computeOutstandingLaneJobs(laneJobs);
        mission.progress.neededCarryParts = neededCarryParts;
        mission.progress.intendedCarryParts = mission.meta.intendedCarryParts;
        mission.progress.assignedCarryParts = assignedCarryParts;
        mission.progress.desiredCount = desiredCount;
        mission.progress.assignedPrimary = mission.assigned.primary.length;
        mission.lastProgressTick = Game.time;

        const isLoopCore = !!(runtime.paths && runtime.paths.core && runtime.paths.core.isLoop);
        if (isLoopCore) {
            let forwardJobs = 0;
            let reverseJobs = 0;
            let sameIndexJobs = 0;
            for (let i = 0; i < laneJobs.length; i++) {
                const job = laneJobs[i];
                if (!job || job.pathKey !== 'core') continue;
                if (!Number.isInteger(job.sourceIndex) || !Number.isInteger(job.targetIndex)) continue;
                if (job.sourceIndex === job.targetIndex) {
                    sameIndexJobs++;
                    continue;
                }
                if (job.targetIndex > job.sourceIndex) forwardJobs++;
                else reverseJobs++;
            }
            logLogisticsDebug(
                `[LogisticsCoreV2] ${room.name} loop active rebuild=${shouldRebuild ? 1 : 0} ` +
                `assigned=${mission.assigned.primary.length}/${desiredCount} jobs=${laneJobs.length} ` +
                `outstanding=${mission.progress.jobsOutstanding} coreLen=${mission.progress.pathLength} ` +
                `dirFwd=${forwardJobs} dirRev=${reverseJobs} sameIdx=${sameIndexJobs}`
            );
        }

    },

    isComplete() {
        return false;
    },

    toContractMission(mission) {
        const desiredCount = mission && mission.meta && Number.isFinite(mission.meta.desiredCount)
            ? Math.max(1, Math.floor(mission.meta.desiredCount))
            : 1;
        const neededCarryParts = mission && mission.meta && Number.isFinite(mission.meta.neededCarryParts)
            ? Math.max(1, Math.floor(mission.meta.neededCarryParts))
            : desiredCount;
        return {
            name: mission && mission.meta && mission.meta.missionName
                ? mission.meta.missionName
                : `logistics:coreV2:${(mission && (mission.targetRoom || mission.sponsorRoom)) || 'room'}`,
            type: 'core_lane_v2',
            archetype: 'coreLaneHauler',
            roleCensus: 'coreLaneHauler',
            requirements: {
                archetype: 'coreLaneHauler',
                minCount: 1,
                maxCount: 1,
                requiredCarry: neededCarryParts,
                spawn: true,
                spawnFromFleet: false
            },
            priority: mission && Number.isFinite(mission.priority) ? mission.priority : 92
        };
    }
};
