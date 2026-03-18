const missionBoard = require('managers_overseer_missions_board_missionBoard');
const missionRuntime = require('managers_overseer_missions_board_missionRuntime');

const STATE_LOAD = 'LOAD';
const STATE_DELIVER = 'DELIVER';
const STATE_RETURN = 'RETURN';
const RENEW_START_TTL = 1100;
const RENEW_STOP_TTL = 1450;

function logCoreLaneDebug(creep, mission, message) {
    if (typeof debug !== 'function' || !creep || !mission) return;
    debug('mission.logistics', `[CoreLaneExec] ${creep.name} ${mission.targetRoom || mission.sponsorRoom} ${message}`);
}

function posKey(pos) {
    return pos ? `${pos.roomName}:${pos.x},${pos.y}` : '';
}

function getMissionForCreep(creep) {
    if (!creep || !creep.memory) return null;
    const missionId = creep.memory.coreLaneMissionId || creep.memory.missionId;
    if (!missionId) return null;
    const mission = missionBoard.getById(missionId);
    if (!mission || mission.type !== 'logisticsCoreV2') return null;
    return mission;
}

function getRuntimeForCreep(creep, mission) {
    if (!creep || !mission) return null;
    const runtime = missionRuntime.getMissionRuntime(mission);
    if (!runtime || !runtime.paths || !runtime.paths.core || !Array.isArray(runtime.paths.core.path) || runtime.paths.core.path.length <= 0) {
        return null;
    }
    return runtime;
}

function getLaneRuntime(runtime, key) {
    if (!runtime || !runtime.paths) return null;
    if (key && runtime.paths[key] && Array.isArray(runtime.paths[key].path) && runtime.paths[key].path.length > 0) {
        return runtime.paths[key];
    }
    return runtime.paths.core || null;
}

function getCurrentIndex(creep, lane) {
    if (!creep || !lane || !lane.indexByPos) return -1;
    const idx = lane.indexByPos[posKey(creep.pos)];
    return Number.isInteger(idx) ? idx : -1;
}

function moveToNearestPathTile(creep, lane, missionId, options) {
    if (!creep || !lane || !Array.isArray(lane.path)) return;
    const opts = options || {};
    const preferredIndices = Array.isArray(opts.preferredIndices) ? opts.preferredIndices : [];

    function moveBestFromIndices(indices) {
        let best = null;
        let bestRange = Infinity;
        for (let i = 0; i < indices.length; i++) {
            const idx = indices[i];
            if (!Number.isInteger(idx) || idx < 0 || idx >= lane.path.length) continue;
            const tile = lane.path[idx];
            if (!tile || tile.roomName !== creep.room.name) continue;
            const range = creep.pos.getRangeTo(tile);
            if (range < bestRange) {
                bestRange = range;
                best = tile;
            }
        }
        if (best) {
            creep.moveTo(best, { range: 0, reusePath: 3 });
            return true;
        }
        return false;
    }

    if (preferredIndices.length > 0 && moveBestFromIndices(preferredIndices)) return;

    let best = null;
    let bestRange = Infinity;
    for (let i = 0; i < lane.path.length; i++) {
        const tile = lane.path[i];
        if (!tile || tile.roomName !== creep.room.name) continue;
        const range = creep.pos.getRangeTo(tile);
        if (range < bestRange) {
            bestRange = range;
            best = tile;
        }
    }
    if (best) creep.moveTo(best, { range: 0, reusePath: 3 });
}

function buildLoopPreferredIndices(targetIndex, length) {
    if (!Number.isInteger(targetIndex) || !Number.isFinite(length) || length <= 0) return [];
    const out = [];
    const seen = Object.create(null);
    const offsets = [0, 1, -1, 2, -2, 3, -3];
    for (let i = 0; i < offsets.length; i++) {
        const idx = loopNormalizeIndex(targetIndex + offsets[i], length);
        if (idx < 0 || seen[idx]) continue;
        seen[idx] = true;
        out.push(idx);
    }
    return out;
}

function getLoopHeadQueueTargetIndex(creep, lane, missionId) {
    if (!lane || !Array.isArray(lane.path) || lane.path.length <= 0) return 0;
    if (lane.path.length === 1) return 0;
    const traffic = getCoreLaneTrafficCache(missionId);
    const occupied = traffic && traffic.posToName ? traffic.posToName : null;

    const headTile = lane.path[0];
    const headHolder = headTile && occupied ? occupied[posKey(headTile)] : null;
    if (!headHolder || headHolder === creep.name) return 0;

    const queueStart = 1;
    const queueWindow = Math.min(4, lane.path.length - 1);
    for (let i = queueStart; i <= queueWindow; i++) {
        const tile = lane.path[i];
        if (!tile || !occupied) return i;
        const holder = occupied[posKey(tile)];
        if (!holder || holder === creep.name) return i;
    }
    return queueStart;
}

function getLoopIdleHeadIndex(lane) {
    if (!lane || !Array.isArray(lane.path) || lane.path.length <= 1) return 0;
    return 1;
}

function getLoopIdleQueueIndex(creep, lane, missionId) {
    if (!lane || !Array.isArray(lane.path) || lane.path.length <= 1) return 0;
    const traffic = getCoreLaneTrafficCache(missionId);
    const occupied = traffic && traffic.posToName ? traffic.posToName : null;
    const queueWindow = Math.min(4, lane.path.length - 1);
    const current = getCurrentIndex(creep, lane);

    // If already parked in queue band, hold position unless it is clearly occupied by another creep.
    if (Number.isInteger(current) && current >= 1 && current <= queueWindow) {
        const tile = lane.path[current];
        const holder = tile && occupied ? occupied[posKey(tile)] : null;
        if (!holder || holder === creep.name) return current;
    }

    for (let i = 1; i <= queueWindow; i++) {
        const tile = lane.path[i];
        const holder = tile && occupied ? occupied[posKey(tile)] : null;
        if (!holder || holder === creep.name) return i;
    }

    if (Number.isInteger(current) && current >= 1) return current;
    return 1;
}

function shouldKeepLoopHeadSlot(creep, lane, missionId) {
    if (!creep || !lane || !Array.isArray(lane.path) || lane.path.length <= 1) return false;
    const traffic = getCoreLaneTrafficCache(missionId);
    const occupied = traffic && traffic.posToName ? traffic.posToName : null;
    const headTile = lane.path[0];
    const headHolder = headTile && occupied ? occupied[posKey(headTile)] : null;
    if (headHolder && headHolder !== creep.name) return false;
    if (headHolder === creep.name) return true;

    const length = lane.path.length;
    let bestName = null;
    let bestDist = Infinity;

    if (traffic && traffic.byName) {
        for (const name in traffic.byName) {
            const c = traffic.byName[name];
            if (!c || !c.my || !c.memory) continue;
            if (c.memory.missionType !== 'logisticsCoreV2') continue;
            const idx = getCurrentIndex(c, lane);
            if (idx < 0) continue;
            const fwd = loopDistanceForward(idx, 0, length);
            const rev = loopDistanceForward(0, idx, length);
            const dist = Math.min(fwd, rev);
            if (dist < bestDist || (dist === bestDist && (!bestName || name < bestName))) {
                bestDist = dist;
                bestName = name;
            }
        }
    }

    // If no on-lane peer found, self becomes keeper when on-lane.
    if (!bestName) return getCurrentIndex(creep, lane) >= 0;
    return bestName === creep.name;
}

function getCoreLaneTrafficCache(missionId) {
    if (!missionId) return null;
    if (!global.__coreLaneTrafficCache || typeof global.__coreLaneTrafficCache !== 'object') {
        global.__coreLaneTrafficCache = { tick: -1, byMission: Object.create(null) };
    }
    const root = global.__coreLaneTrafficCache;
    if (root.tick !== Game.time) {
        root.tick = Game.time;
        root.byMission = Object.create(null);
    }
    if (root.byMission[missionId]) return root.byMission[missionId];

    const entry = {
        posToName: Object.create(null),
        byName: Object.create(null)
    };
    for (const name in Game.creeps) {
        const c = Game.creeps[name];
        if (!c || !c.my || !c.memory) continue;
        if (c.memory.missionType !== 'logisticsCoreV2') continue;
        const cid = c.memory.coreLaneMissionId || c.memory.missionId;
        if (cid !== missionId) continue;
        const key = posKey(c.pos);
        if (key) entry.posToName[key] = c.name;
        entry.byName[c.name] = c;
    }
    root.byMission[missionId] = entry;
    return entry;
}

function getRoadSpeedScore(creep) {
    if (!creep || !Array.isArray(creep.body)) return 0;
    const moveParts = creep.getActiveBodyparts(MOVE);
    let nonMove = 0;
    for (let i = 0; i < creep.body.length; i++) {
        const part = creep.body[i];
        if (!part || part.hits <= 0) continue;
        if (part.type !== MOVE) nonMove++;
    }
    return (moveParts * 2) - nonMove;
}

function getLanePriority(creep) {
    if (!creep || !creep.memory) return 0;
    const state = creep.memory.coreLaneState || '';
    const mode = creep.memory.coreLaneMode || '';
    if (state === STATE_DELIVER && mode === 'core') return 4;
    if (state === STATE_DELIVER && mode === 'labs') return 3;
    if (state === STATE_LOAD) return 2;
    if (state === STATE_RETURN) return 1;
    return 0;
}

function shouldYield(self, other) {
    if (!self || !other) return true;
    const selfPriority = getLanePriority(self);
    const otherPriority = getLanePriority(other);
    if (selfPriority !== otherPriority) return selfPriority < otherPriority;

    const selfSpeed = getRoadSpeedScore(self);
    const otherSpeed = getRoadSpeedScore(other);
    if (selfSpeed !== otherSpeed) return selfSpeed > otherSpeed;

    return self.name > other.name;
}

function getCreepIntentTargetIndex(creep, lane, runtime) {
    if (!creep || !creep.memory || !lane || !Array.isArray(lane.path)) return null;
    const state = creep.memory.coreLaneState || STATE_LOAD;
    const mode = creep.memory.coreLaneMode || 'core';
    const endIndex = Math.max(0, lane.path.length - 1);

    if (state === STATE_RETURN) return 0;
    if (state === STATE_DELIVER && mode === 'core') return endIndex;
    if (state === STATE_LOAD && mode === 'core') return 0;

    const jobId = creep.memory.coreLaneJobId || null;
    const job = jobId && runtime && runtime.laneJobsById ? runtime.laneJobsById[jobId] : null;
    if (!job) return state === STATE_DELIVER ? endIndex : 0;

    if (state === STATE_LOAD) {
        return Number.isInteger(job.sourceIndex) ? job.sourceIndex : 0;
    }
    if (state === STATE_DELIVER) {
        return Number.isInteger(job.targetIndex) ? job.targetIndex : endIndex;
    }
    return 0;
}

function trySwapWithHigherPriority(creep, blocker, lane, currentIndex, targetIndex, runtime) {
    if (!creep || !blocker || !lane || !Array.isArray(lane.path)) return false;
    if (creep.fatigue > 0 || blocker.fatigue > 0) return false;
    if (!creep.pos.isNearTo(blocker.pos)) return false;

    const blockerIndex = getCurrentIndex(blocker, lane);
    if (blockerIndex < 0) return false;
    const selfDir = targetIndex > currentIndex ? 1 : -1;
    const expectedBlockerIndex = currentIndex + selfDir;
    if (blockerIndex !== expectedBlockerIndex) return false;

    const blockerTargetIndex = getCreepIntentTargetIndex(blocker, lane, runtime);
    if (!Number.isInteger(blockerTargetIndex) || blockerTargetIndex === blockerIndex) return false;
    const blockerDir = blockerTargetIndex > blockerIndex ? 1 : -1;
    if (blockerDir !== -selfDir) return false;

    const blockerMove = blocker.move(blocker.pos.getDirectionTo(creep.pos));
    if (blockerMove !== OK) return false;
    const creepMove = creep.move(creep.pos.getDirectionTo(blocker.pos));
    if (creepMove !== OK) return false;
    return true;
}

function isWalkableYieldTile(creep, x, y, traffic) {
    if (!creep || x < 0 || x > 49 || y < 0 || y > 49) return false;
    const terrain = creep.room.getTerrain();
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) return false;

    const key = `${creep.room.name}:${x},${y}`;
    if (traffic && traffic.posToName && traffic.posToName[key] && traffic.posToName[key] !== creep.name) return false;

    const structures = creep.room.lookForAt(LOOK_STRUCTURES, x, y);
    for (let i = 0; i < structures.length; i++) {
        const s = structures[i];
        if (!s) continue;
        if (s.structureType === STRUCTURE_ROAD) continue;
        if (s.structureType === STRUCTURE_CONTAINER) continue;
        if (s.structureType === STRUCTURE_RAMPART && (s.my || s.isPublic)) continue;
        return false;
    }
    const sites = creep.room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
    for (let i = 0; i < sites.length; i++) {
        const site = sites[i];
        if (!site) continue;
        if (site.structureType === STRUCTURE_ROAD || site.structureType === STRUCTURE_CONTAINER) continue;
        return false;
    }
    return true;
}

function tryYieldMove(creep, lane, currentIndex, targetIndex, traffic) {
    if (!creep || !lane || !Array.isArray(lane.path)) return false;
    const path = lane.path;
    const reverseIndex = currentIndex < targetIndex ? currentIndex - 1 : currentIndex + 1;
    if (reverseIndex >= 0 && reverseIndex < path.length) {
        const backPos = path[reverseIndex];
        if (backPos && isWalkableYieldTile(creep, backPos.x, backPos.y, traffic)) {
            const occupied = traffic && traffic.posToName ? traffic.posToName[posKey(backPos)] : null;
            if (!occupied || occupied === creep.name) {
                creep.move(creep.pos.getDirectionTo(backPos));
                return true;
            }
        }
    }

    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const x = creep.pos.x + dx;
            const y = creep.pos.y + dy;
            if (!isWalkableYieldTile(creep, x, y, traffic)) continue;
            const candidate = new RoomPosition(x, y, creep.room.name);
            if (lane.indexByPos && Number.isInteger(lane.indexByPos[posKey(candidate)])) continue;
            creep.move(creep.pos.getDirectionTo(candidate));
            return true;
        }
    }
    return false;
}

function stepTowardIndex(creep, lane, targetIndex, missionId, runtime) {
    if (!creep || !lane || !Array.isArray(lane.path)) return 'invalid_lane';
    const path = lane.path;
    if (targetIndex < 0 || targetIndex >= path.length) return 'invalid_target';

    const currentIndex = getCurrentIndex(creep, lane);
    if (currentIndex < 0) {
        moveToNearestPathTile(creep, lane, missionId, { preferredIndices: [targetIndex] });
        return 'move_to_path';
    }

    if (currentIndex === targetIndex) return 'at_target_index';

    const nextIndex = currentIndex < targetIndex ? currentIndex + 1 : currentIndex - 1;
    const nextPos = path[nextIndex];
    if (!nextPos) return 'missing_next_pos';

    const moveCode = creep.move(creep.pos.getDirectionTo(nextPos));
    if (moveCode === OK) return 'step';

    creep.moveTo(nextPos, { range: 0, reusePath: 0 });
    return `move_err:${moveCode}`;
}

function loopNormalizeIndex(index, length) {
    if (!Number.isInteger(index) || !Number.isFinite(length) || length <= 0) return -1;
    const mod = index % length;
    return mod < 0 ? mod + length : mod;
}

function loopDistanceForward(fromIndex, toIndex, length) {
    if (length <= 0) return Infinity;
    const from = loopNormalizeIndex(fromIndex, length);
    const to = loopNormalizeIndex(toIndex, length);
    if (from < 0 || to < 0) return Infinity;
    return to >= from ? (to - from) : (length - from + to);
}

function getLoopDirectionToward(creep, lane, fromIndex, toIndex) {
    const pathLength = lane && Array.isArray(lane.path) ? lane.path.length : 0;
    if (pathLength <= 0) return 1;
    const from = loopNormalizeIndex(fromIndex, pathLength);
    const to = loopNormalizeIndex(toIndex, pathLength);
    if (from < 0 || to < 0 || from === to) return 1;

    const fwd = loopDistanceForward(from, to, pathLength);
    const rev = loopDistanceForward(to, from, pathLength);
    if (fwd < rev) return 1;
    if (rev < fwd) return -1;

    const memDir = creep && creep.memory ? creep.memory._coreLaneLoopDir : 0;
    if (memDir === 1 || memDir === -1) return memDir;
    return 1;
}

function getLoopNextIndex(currentIndex, direction, length) {
    if (!Number.isInteger(currentIndex) || !Number.isFinite(length) || length <= 0) return -1;
    const step = direction === -1 ? -1 : 1;
    return loopNormalizeIndex(currentIndex + step, length);
}

function tryLoopYieldMove(creep, lane, currentIndex, direction, traffic) {
    if (!creep || !lane || !Array.isArray(lane.path) || lane.path.length <= 0) return false;
    const reverse = getLoopNextIndex(currentIndex, direction === 1 ? -1 : 1, lane.path.length);
    if (reverse >= 0) {
        const backPos = lane.path[reverse];
        if (backPos && isWalkableYieldTile(creep, backPos.x, backPos.y, traffic)) {
            const occupied = traffic && traffic.posToName ? traffic.posToName[posKey(backPos)] : null;
            if (!occupied || occupied === creep.name) {
                creep.move(creep.pos.getDirectionTo(backPos));
                return true;
            }
        }
    }

    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const x = creep.pos.x + dx;
            const y = creep.pos.y + dy;
            if (!isWalkableYieldTile(creep, x, y, traffic)) continue;
            const candidate = new RoomPosition(x, y, creep.room.name);
            if (lane.indexByPos && Number.isInteger(lane.indexByPos[posKey(candidate)])) continue;
            creep.move(creep.pos.getDirectionTo(candidate));
            return true;
        }
    }
    return false;
}

function tryLoopSwapWithLowerPriority(creep, blocker, lane, currentIndex, nextIndex, missionId, runtime) {
    if (!creep || !blocker || !lane || !Array.isArray(lane.path)) return false;
    if (creep.fatigue > 0 || blocker.fatigue > 0) return false;
    if (!creep.pos.isNearTo(blocker.pos)) return false;
    if (!Number.isInteger(currentIndex) || !Number.isInteger(nextIndex)) return false;

    const blockerIndex = getCurrentIndex(blocker, lane);
    if (blockerIndex !== nextIndex) return false;

    // Only force swap when blocker should yield to us by lane priority.
    if (!shouldYield(blocker, creep)) return false;

    const len = lane.path.length;
    if (len <= 0) return false;
    const selfDir = nextIndex === getLoopNextIndex(currentIndex, 1, len) ? 1 : -1;
    const blockerTarget = getCreepIntentTargetIndex(blocker, lane, runtime);
    let blockerAllowsSwap = false;
    if (!Number.isInteger(blockerTarget) || blockerTarget === blockerIndex) {
        // Stationary blocker: allow priority preemption swap.
        blockerAllowsSwap = true;
    } else {
        const blockerDir = getLoopDirectionToward(blocker, lane, blockerIndex, blockerTarget);
        // Swap only when intents conflict (opposite directions), avoid same-direction churn.
        blockerAllowsSwap = blockerDir !== selfDir;
    }
    if (!blockerAllowsSwap) return false;

    const blockerMove = blocker.move(blocker.pos.getDirectionTo(creep.pos));
    if (blockerMove !== OK) return false;
    const creepMove = creep.move(creep.pos.getDirectionTo(blocker.pos));
    if (creepMove !== OK) return false;

    // Keep traffic cache coherent for same-tick subsequent reads.
    const traffic = getCoreLaneTrafficCache(missionId);
    if (traffic && traffic.posToName) {
        traffic.posToName[posKey(creep.pos)] = blocker.name;
        traffic.posToName[posKey(blocker.pos)] = creep.name;
    }
    return true;
}

function stepTowardLoopIndex(creep, lane, targetIndex, missionId, runtime) {
    if (!creep || !lane || !Array.isArray(lane.path) || lane.path.length <= 0) return 'invalid_lane';
    const pathLength = lane.path.length;
    const target = loopNormalizeIndex(targetIndex, pathLength);
    if (target < 0) return 'invalid_target';

    const currentIndex = getCurrentIndex(creep, lane);
    if (currentIndex < 0) {
        moveToNearestPathTile(creep, lane, missionId, { preferredIndices: [target] });
        return 'move_to_path';
    }

    if (currentIndex === target) return 'at_target_index';

    const dir = getLoopDirectionToward(creep, lane, currentIndex, target);
    const nextIndex = getLoopNextIndex(currentIndex, dir, pathLength);
    if (nextIndex < 0) return 'invalid_next_index';

    const nextPos = lane.path[nextIndex];
    if (!nextPos) return 'missing_next_pos';

    const moveCode = creep.move(creep.pos.getDirectionTo(nextPos));
    if (moveCode === OK) {
        creep.memory._coreLaneLoopDir = dir;
        return 'step';
    }

    creep.moveTo(nextPos, { range: 0, reusePath: 0 });
    return `move_err:${moveCode}`;
}

function getNearestDemandIndexOnLoop(creep, lane, resourceType) {
    if (!creep || !lane || !lane.stopsByIndex || !Array.isArray(lane.path) || lane.path.length <= 0) return -1;
    const currentIndex = getCurrentIndex(creep, lane);
    if (currentIndex < 0) return -1;
    const length = lane.path.length;
    const rt = resourceType || RESOURCE_ENERGY;
    let best = -1;
    let bestDistance = Infinity;

    for (const idxKey in lane.stopsByIndex) {
        const idx = Number(idxKey);
        if (!Number.isInteger(idx)) continue;
        const stopIds = lane.stopsByIndex[idx];
        if (!Array.isArray(stopIds) || stopIds.length <= 0) continue;
        let hasDemand = false;
        for (let i = 0; i < stopIds.length; i++) {
            const target = Game.getObjectById(stopIds[i]);
            if (!target || !target.store || typeof target.store.getFreeCapacity !== 'function') continue;
            if (target.store.getFreeCapacity(rt) > 0) {
                hasDemand = true;
                break;
            }
        }
        if (!hasDemand) continue;
        const normalized = loopNormalizeIndex(idx, length);
        if (normalized < 0) continue;
        const fwd = loopDistanceForward(currentIndex, normalized, length);
        const rev = loopDistanceForward(normalized, currentIndex, length);
        const dist = Math.min(fwd, rev);
        if (dist < bestDistance) {
            bestDistance = dist;
            best = normalized;
        }
    }

    return best;
}

function getStoreAmount(obj, resourceType) {
    if (!obj || !resourceType) return 0;
    if (obj.store) return obj.store[resourceType] || 0;
    if (obj.resourceType === resourceType && Number.isFinite(obj.amount)) return obj.amount;
    return 0;
}

function countBodyParts(creep, partType) {
    if (!creep || !Array.isArray(creep.body)) return 0;
    let total = 0;
    for (let i = 0; i < creep.body.length; i++) {
        const part = creep.body[i];
        if (part && part.type === partType) total++;
    }
    return total;
}

function getIntendedCarryParts(mission, creep) {
    const fromMission = mission && mission.meta && Number.isFinite(mission.meta.intendedCarryParts)
        ? Math.max(1, Math.floor(mission.meta.intendedCarryParts))
        : null;
    if (fromMission) return fromMission;
    const cap = Math.max(300, creep && creep.room ? (creep.room.energyCapacityAvailable || 300) : 300);
    return Math.max(2, Math.min(25, Math.floor(cap / 100)));
}

function isIntendedRenewBody(creep, mission) {
    if (!creep) return false;
    const intendedCarry = getIntendedCarryParts(mission, creep);
    return countBodyParts(creep, CARRY) === intendedCarry;
}

function getAdjacentRenewSpawn(creep) {
    if (!creep || !creep.room) return null;
    const spawns = creep.room.find(FIND_MY_SPAWNS);
    if (!spawns || spawns.length <= 0) return null;
    for (let i = 0; i < spawns.length; i++) {
        const spawn = spawns[i];
        if (!spawn || spawn.spawning) continue;
        if (!creep.pos.inRangeTo(spawn, 1)) continue;
        return spawn;
    }
    return null;
}

function shouldRenewNow(creep) {
    if (!creep || !Number.isFinite(creep.ticksToLive)) return false;
    if (creep.ticksToLive >= RENEW_STOP_TTL) return false;
    if (creep.memory.coreLaneRenewing) return true;
    return creep.ticksToLive <= RENEW_START_TTL;
}

function canIgnoreSpawnDemandForRenew(creep, mission, coreLane, activeJob) {
    if (!creep || !mission || !coreLane) return false;
    if (!shouldRenewNow(creep)) return false;
    if (!isIntendedRenewBody(creep, mission)) return false;
    if ((creep.memory.coreLaneState || STATE_LOAD) !== STATE_LOAD) return false;
    if (activeJob) {
        const idleStockJob = activeJob.kind === 'stock' && creep.store.getUsedCapacity() <= 0;
        if (!idleStockJob) return false;
    }
    if ((creep.store && creep.store.getUsedCapacity && creep.store.getUsedCapacity()) > 0) return false;
    if (getCurrentIndex(creep, coreLane) !== 0) return false;
    return !!getAdjacentRenewSpawn(creep);
}

function tryRenewIdleHeadHauler(creep, mission, coreLane, hasCoreDemand, activeJob) {
    if (!creep || !mission || !coreLane) return false;
    if (!shouldRenewNow(creep)) {
        if (Number.isFinite(creep.ticksToLive) && creep.ticksToLive >= RENEW_STOP_TTL) {
            delete creep.memory.coreLaneRenewing;
        }
        return false;
    }
    if (!isIntendedRenewBody(creep, mission)) {
        delete creep.memory.coreLaneRenewing;
        return false;
    }
    if ((creep.memory.coreLaneState || STATE_LOAD) !== STATE_LOAD) return false;
    if (hasCoreDemand) return false;
    if (activeJob) {
        const idleStockJob = activeJob.kind === 'stock' && creep.store.getUsedCapacity() <= 0;
        if (!idleStockJob) return false;
    }
    if ((creep.store && creep.store.getUsedCapacity && creep.store.getUsedCapacity()) > 0) return false;
    if (getCurrentIndex(creep, coreLane) !== 0) return false;

    const spawn = getAdjacentRenewSpawn(creep);
    if (!spawn) {
        delete creep.memory.coreLaneRenewing;
        return false;
    }

    const renewCode = spawn.renewCreep(creep);
    if (renewCode === OK) {
        creep.memory.coreLaneRenewing = true;
        logCoreLaneDebug(
            creep,
            mission,
            `renew OK spawn=${spawn.id} ttl=${creep.ticksToLive} carry=${countBodyParts(creep, CARRY)}`
        );
        return true;
    }

    if (renewCode === ERR_FULL) {
        delete creep.memory.coreLaneRenewing;
        return false;
    }

    if (renewCode === ERR_NOT_ENOUGH_ENERGY || renewCode === ERR_BUSY || renewCode === ERR_NOT_IN_RANGE) {
        delete creep.memory.coreLaneRenewing;
    }

    if (renewCode !== ERR_BUSY) {
        logCoreLaneDebug(creep, mission, `renew skip code=${renewCode} spawn=${spawn.id}`);
    }
    return false;
}

function getHeadSource(creep, mission, runtime) {
    if (!creep || !mission) return null;
    const headSourceId = (runtime && runtime.headSourceId) || (mission.meta && mission.meta.headSourceId) || null;
    const preferred = headSourceId ? Game.getObjectById(headSourceId) : null;
    if (preferred) return preferred;

    if (creep.room.storage) return creep.room.storage;
    const spawns = creep.room.find(FIND_MY_SPAWNS);
    return spawns && spawns.length > 0 ? spawns[0] : null;
}

function getPrimaryDumpTarget(creep, mission, runtime, resourceType) {
    if (!creep || !resourceType) return null;
    if (creep.room.storage && creep.room.storage.store && creep.room.storage.store.getFreeCapacity(resourceType) > 0) {
        return creep.room.storage;
    }
    if (creep.room.terminal && creep.room.terminal.store && creep.room.terminal.store.getFreeCapacity(resourceType) > 0) {
        return creep.room.terminal;
    }
    const head = getHeadSource(creep, mission, runtime);
    if (head && head.store && typeof head.store.getFreeCapacity === 'function' && head.store.getFreeCapacity(resourceType) > 0) {
        return head;
    }
    return null;
}

function dumpNonJobCargo(creep, mission, runtime, keepResourceType) {
    if (!creep) return false;
    for (const rt in creep.store) {
        if ((creep.store[rt] || 0) <= 0) continue;
        if (keepResourceType && rt === keepResourceType) continue;
        const target = getPrimaryDumpTarget(creep, mission, runtime, rt);
        if (!target) continue;
        if (!creep.pos.inRangeTo(target, 1)) {
            creep.moveTo(target, { range: 1, reusePath: 3 });
            return true;
        }
        creep.transfer(target, rt);
        return true;
    }
    return false;
}

function laneHasEnergyDemand(lane, opts) {
    if (!lane || !lane.stopsByIndex) return false;
    const options = opts || {};
    const ignoreSpawn = options.ignoreSpawn === true;
    for (const idxKey in lane.stopsByIndex) {
        const stopIds = lane.stopsByIndex[idxKey];
        if (!Array.isArray(stopIds) || stopIds.length <= 0) continue;
        for (let i = 0; i < stopIds.length; i++) {
            const target = Game.getObjectById(stopIds[i]);
            if (!target || !target.store || typeof target.store.getFreeCapacity !== 'function') continue;
            if (ignoreSpawn && target.structureType === STRUCTURE_SPAWN) continue;
            if (target.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return true;
        }
    }
    return false;
}

function indexHasEnergyDemand(lane, index, opts) {
    if (!lane || !lane.stopsByIndex || !Number.isInteger(index)) return false;
    const options = opts || {};
    const ignoreSpawn = options.ignoreSpawn === true;
    const stopIds = lane.stopsByIndex[index];
    if (!Array.isArray(stopIds) || stopIds.length <= 0) return false;
    for (let i = 0; i < stopIds.length; i++) {
        const target = Game.getObjectById(stopIds[i]);
        if (!target || !target.store || typeof target.store.getFreeCapacity !== 'function') continue;
        if (ignoreSpawn && target.structureType === STRUCTURE_SPAWN) continue;
        if (target.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return true;
    }
    return false;
}

function transferEnergyAtCurrentIndex(creep, lane, opts) {
    if (!creep || !lane || !lane.stopsByIndex) return false;
    const options = opts || {};
    const ignoreSpawn = options.ignoreSpawn === true;
    const idx = getCurrentIndex(creep, lane);
    if (idx < 0) return false;
    const stopIds = lane.stopsByIndex[idx];
    if (!Array.isArray(stopIds) || stopIds.length <= 0) return false;

    let best = null;
    let bestNeed = 0;
    for (let i = 0; i < stopIds.length; i++) {
        const target = Game.getObjectById(stopIds[i]);
        if (!target || !target.store || typeof target.store.getFreeCapacity !== 'function') continue;
        if (ignoreSpawn && target.structureType === STRUCTURE_SPAWN) continue;
        if (!creep.pos.inRangeTo(target, 1)) continue;
        const need = target.store.getFreeCapacity(RESOURCE_ENERGY);
        if (need > bestNeed) {
            bestNeed = need;
            best = target;
        }
    }

    if (!best) return false;
    return creep.transfer(best, RESOURCE_ENERGY) === OK;
}

function getLaneJobById(runtime, id) {
    if (!runtime || !id || !runtime.laneJobsById) return null;
    return runtime.laneJobsById[id] || null;
}

function getJobClaimStore(missionId) {
    if (!missionId) return null;
    if (!global.__coreLaneJobClaims || typeof global.__coreLaneJobClaims !== 'object') {
        global.__coreLaneJobClaims = { tick: -1, byMission: Object.create(null) };
    }
    const root = global.__coreLaneJobClaims;
    if (root.tick !== Game.time) {
        root.tick = Game.time;
        root.byMission = Object.create(null);
    }
    if (!root.byMission[missionId]) root.byMission[missionId] = Object.create(null);
    return root.byMission[missionId];
}

function claimJob(missionId, jobId, creepName) {
    const store = getJobClaimStore(missionId);
    if (!store || !jobId || !creepName) return;
    store[jobId] = creepName;
}

function isJobClaimedByOther(missionId, jobId, creepName) {
    const store = getJobClaimStore(missionId);
    if (!store || !jobId) return false;
    const holder = store[jobId];
    return !!(holder && holder !== creepName);
}

function isJobRunnable(job, carriedAmount) {
    if (!job || !job.resourceType) return false;
    const target = job.targetId ? Game.getObjectById(job.targetId) : null;
    if (!target || !target.store || typeof target.store.getFreeCapacity !== 'function') return false;
    if (target.store.getFreeCapacity(job.resourceType) <= 0) return false;

    const carried = Number.isFinite(carriedAmount) ? carriedAmount : 0;
    if (carried > 0) return true;

    const source = job.sourceId ? Game.getObjectById(job.sourceId) : null;
    if (!source) return false;
    return getStoreAmount(source, job.resourceType) > 0;
}

function pickLaneJob(runtime, creep, missionId) {
    if (!runtime || !Array.isArray(runtime.laneJobs) || runtime.laneJobs.length <= 0) return null;
    for (let i = 0; i < runtime.laneJobs.length; i++) {
        const job = runtime.laneJobs[i];
        if (!job) continue;
        if (isJobClaimedByOther(missionId, job.id, creep && creep.name)) continue;
        const carried = creep && creep.store ? (creep.store[job.resourceType] || 0) : 0;
        if (isJobRunnable(job, carried)) return job;
    }
    return null;
}

function shouldPickNewSideJob(creep, coreLane) {
    if (!creep || !creep.memory || !coreLane) return false;
    if (creep.memory.coreLaneState !== STATE_LOAD) return false;
    if ((creep.memory.coreLaneMode || 'core') !== 'core') return false;
    if (creep.store && creep.store.getUsedCapacity() > 0) return false;
    return getCurrentIndex(creep, coreLane) === 0;
}

function clearJobMemory(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.coreLaneJobId;
    delete creep.memory.coreLaneMode;
    delete creep.memory.coreLaneResourceType;
}

function unassignCreep(creep) {
    if (!creep || !creep.memory) return;
    if (creep.memory.coreLanePrevRole) {
        creep.memory.role = creep.memory.coreLanePrevRole;
    }
    delete creep.memory.coreLaneMissionId;
    delete creep.memory.missionType;
    delete creep.memory.missionId;
    delete creep.memory.coreLaneState;
    delete creep.memory.coreLanePrevRole;
    clearJobMemory(creep);
}

module.exports = {
    run(creep) {
        if (!creep || !creep.my) return;
        const mission = getMissionForCreep(creep);
        if (!mission) {
            unassignCreep(creep);
            return;
        }

        const runtime = getRuntimeForCreep(creep, mission);
        const coreLane = runtime ? getLaneRuntime(runtime, 'core') : null;
        if (!runtime || !coreLane || !coreLane.headPos) {
            if (creep.room.name === mission.targetRoom && mission.meta && mission.meta.headSourceId) {
                const headSource = Game.getObjectById(mission.meta.headSourceId);
                if (headSource) creep.moveTo(headSource, { range: 1, reusePath: 3 });
            }
            return;
        }

        if (!creep.memory.coreLaneState) creep.memory.coreLaneState = STATE_LOAD;
        if (creep.store.getUsedCapacity() <= 0 && creep.memory.coreLaneState !== STATE_RETURN) {
            creep.memory.coreLaneState = STATE_LOAD;
        }
        const coreLaneIsLoop = coreLane.isLoop === true;

        let activeJob = creep.memory.coreLaneJobId ? getLaneJobById(runtime, creep.memory.coreLaneJobId) : null;
        if (activeJob) {
            const carried = creep.store[activeJob.resourceType] || 0;
            if (!isJobRunnable(activeJob, carried)) {
                activeJob = null;
                clearJobMemory(creep);
            }
        }

        if (!activeJob && shouldPickNewSideJob(creep, coreLane)) {
            activeJob = pickLaneJob(runtime, creep, mission.id);
            if (activeJob) {
                creep.memory.coreLaneJobId = activeJob.id;
                creep.memory.coreLaneResourceType = activeJob.resourceType;
            }
        }
        if (activeJob) claimJob(mission.id, activeJob.id, creep.name);
        const ignoreSpawnDemand = canIgnoreSpawnDemandForRenew(creep, mission, coreLane, activeJob);
        const hasCoreDemand = laneHasEnergyDemand(coreLane, { ignoreSpawn: ignoreSpawnDemand });

        if (tryRenewIdleHeadHauler(creep, mission, coreLane, hasCoreDemand, activeJob)) return;

        if (coreLaneIsLoop) {
            const idx = getCurrentIndex(creep, coreLane);
            const jobCarry = activeJob && activeJob.resourceType ? (creep.store[activeJob.resourceType] || 0) : 0;
            const summarySig = [
                creep.memory.coreLaneState || '-',
                creep.memory.coreLaneMode || '-',
                idx,
                activeJob ? activeJob.id : '-',
                creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0,
                jobCarry,
                creep.fatigue || 0
            ].join('|');
            const isLegitIdleHold =
                creep.memory.coreLaneState === STATE_LOAD &&
                (
                    !hasCoreDemand ||
                    (
                        activeJob &&
                        activeJob.kind === 'stock' &&
                        creep.store.getUsedCapacity() <= 0
                    )
                );
            const dbg = creep.memory._coreLaneDebug || { lastSig: null, stallTicks: 0 };
            if (dbg.lastSig === summarySig) {
                if (isLegitIdleHold || (creep.fatigue || 0) > 0) dbg.stallTicks = 0;
                else dbg.stallTicks = (dbg.stallTicks || 0) + 1;
            } else {
                dbg.stallTicks = 0;
            }
            dbg.lastSig = summarySig;
            creep.memory._coreLaneDebug = dbg;

            logCoreLaneDebug(
                creep,
                mission,
                `loop state=${creep.memory.coreLaneState} mode=${creep.memory.coreLaneMode || '-'} idx=${idx} ` +
                `fatigue=${creep.fatigue || 0} job=${activeJob ? activeJob.id : '-'} ` +
                `sIdx=${activeJob && Number.isInteger(activeJob.sourceIndex) ? activeJob.sourceIndex : '-'} ` +
                `tIdx=${activeJob && Number.isInteger(activeJob.targetIndex) ? activeJob.targetIndex : '-'} ` +
                `carryE=${creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0} ` +
                `carryJob=${jobCarry} stalls=${dbg.stallTicks || 0}`
            );
            if (!isLegitIdleHold && (dbg.stallTicks || 0) >= 3) {
                logCoreLaneDebug(
                    creep,
                    mission,
                    `loop stall suspected state=${creep.memory.coreLaneState} mode=${creep.memory.coreLaneMode || '-'} ` +
                    `idx=${idx} job=${activeJob ? activeJob.id : '-'}`
                );
            }
        }

        if (creep.memory.coreLaneState === STATE_LOAD) {
            if (hasCoreDemand) {
                creep.memory.coreLaneMode = 'core';
                if (dumpNonJobCargo(creep, mission, runtime, RESOURCE_ENERGY)) return;
                if ((creep.store[RESOURCE_ENERGY] || 0) > 0) {
                    creep.memory.coreLaneState = STATE_DELIVER;
                    return;
                }

                if (!creep.pos.inRangeTo(coreLane.headPos, 0)) {
                    if (coreLaneIsLoop) {
                        const targetIdx = 0;
                        const moveResult = stepTowardLoopIndex(creep, coreLane, targetIdx, mission.id, runtime);
                        logCoreLaneDebug(creep, mission, `loop LOAD->head move=${moveResult} targetIdx=${targetIdx}`);
                    } else {
                        stepTowardIndex(creep, coreLane, 0, mission.id, runtime);
                    }
                    return;
                }

                const source = getHeadSource(creep, mission, runtime);
                if (!source || !source.store) return;
                if (source.structureType === STRUCTURE_SPAWN && creep.room.storage) return;
                if (source.structureType === STRUCTURE_SPAWN) {
                    const available = source.store[RESOURCE_ENERGY] || 0;
                    if (available <= creep.store.getFreeCapacity(RESOURCE_ENERGY)) return;
                }

                const withdrawCode = creep.withdraw(source, RESOURCE_ENERGY);
                logCoreLaneDebug(
                    creep,
                    mission,
                    `LOAD withdraw head source=${source.id} code=${withdrawCode} ` +
                    `free=${creep.store.getFreeCapacity(RESOURCE_ENERGY) || 0} src=${source.store[RESOURCE_ENERGY] || 0}`
                );
                if ((creep.store[RESOURCE_ENERGY] || 0) > 0) {
                    creep.memory.coreLaneState = STATE_DELIVER;
                }
                return;
            }

            // True idle behavior: when parked at head with no core demand, do not churn stock jobs.
            if (
                activeJob &&
                activeJob.kind === 'stock' &&
                creep.store.getUsedCapacity() <= 0
            ) {
                const idleIdx = 0;
                const idx = getCurrentIndex(creep, coreLane);
                if (idx === idleIdx) return;
                if (idx < 0) {
                    if (coreLaneIsLoop) {
                        moveToNearestPathTile(creep, coreLane, mission.id, {
                            preferredIndices: buildLoopPreferredIndices(idleIdx, coreLane.path.length)
                        });
                    } else {
                        moveToNearestPathTile(creep, coreLane, mission.id, { preferredIndices: [idleIdx] });
                    }
                    return;
                }
                if (coreLaneIsLoop) {
                    stepTowardLoopIndex(creep, coreLane, idleIdx, mission.id, runtime);
                } else {
                    stepTowardIndex(creep, coreLane, idleIdx, mission.id, runtime);
                }
                return;
            }

            if (!activeJob) {
                // Idle at head with energy buffered to avoid withdraw->dump thrash on demand flaps.
                if (dumpNonJobCargo(creep, mission, runtime, RESOURCE_ENERGY)) return;
                const idleIdx = 0;
                const idx = getCurrentIndex(creep, coreLane);
                if (idx < 0) {
                    if (coreLaneIsLoop) {
                        moveToNearestPathTile(creep, coreLane, mission.id, {
                            preferredIndices: buildLoopPreferredIndices(idleIdx, coreLane.path.length)
                        });
                        logCoreLaneDebug(creep, mission, 'loop LOAD idle off-lane -> move_to_path');
                    } else {
                        moveToNearestPathTile(creep, coreLane, mission.id, { preferredIndices: [idleIdx] });
                    }
                    return;
                }
                if (idx !== idleIdx) {
                    if (coreLaneIsLoop) {
                        const moveResult = stepTowardLoopIndex(creep, coreLane, idleIdx, mission.id, runtime);
                        logCoreLaneDebug(creep, mission, `loop LOAD idle park move=${moveResult} targetIdx=${idleIdx}`);
                    } else {
                        stepTowardIndex(creep, coreLane, idleIdx, mission.id, runtime);
                    }
                }
                return;
            }

            const resourceType = activeJob.resourceType;
            const lane = getLaneRuntime(runtime, activeJob.pathKey) || coreLane;
            creep.memory.coreLaneMode = 'labs';
            creep.memory.coreLaneResourceType = resourceType;

            if (dumpNonJobCargo(creep, mission, runtime, resourceType)) return;
            if ((creep.store[resourceType] || 0) > 0) {
                creep.memory.coreLaneState = STATE_DELIVER;
                return;
            }

            const source = Game.getObjectById(activeJob.sourceId);
            if (!source || !source.store || getStoreAmount(source, resourceType) <= 0) {
                clearJobMemory(creep);
                return;
            }

            if (!creep.pos.inRangeTo(source, 1)) {
                if (Number.isInteger(activeJob.sourceIndex) && activeJob.sourceIndex >= 0) {
                    const laneLoop = lane && lane.isLoop === true;
                    const moveResult = laneLoop
                        ? stepTowardLoopIndex(creep, lane, activeJob.sourceIndex, mission.id, runtime)
                        : stepTowardIndex(creep, lane, activeJob.sourceIndex, mission.id, runtime);
                    if (coreLaneIsLoop) {
                        logCoreLaneDebug(
                            creep,
                            mission,
                            `loop LOAD job->source move=${moveResult} idx=${getCurrentIndex(creep, lane)} ` +
                            `targetIdx=${activeJob.sourceIndex} source=${activeJob.sourceId}`
                        );
                    }
                    const idx = getCurrentIndex(creep, lane);
                    if (idx === activeJob.sourceIndex) {
                        creep.moveTo(source, { range: 1, reusePath: 3 });
                    }
                } else {
                    creep.moveTo(source, { range: 1, reusePath: 3 });
                }
                return;
            }

            const withdrawCode = creep.withdraw(source, resourceType);
            logCoreLaneDebug(
                creep,
                mission,
                `LOAD withdraw job source=${source.id} res=${resourceType} code=${withdrawCode} ` +
                `srcAmt=${getStoreAmount(source, resourceType)}`
            );
            if ((creep.store[resourceType] || 0) > 0) {
                creep.memory.coreLaneState = STATE_DELIVER;
            }
            return;
        }

        if (creep.memory.coreLaneState === STATE_DELIVER) {
            if (creep.memory.coreLaneMode === 'core') {
                if (!hasCoreDemand || (creep.store[RESOURCE_ENERGY] || 0) <= 0) {
                    creep.memory.coreLaneState = STATE_RETURN;
                    return;
                }

                const idx = getCurrentIndex(creep, coreLane);
                const endIndex = coreLane.path.length - 1;
                if (idx < 0) {
                    if (coreLaneIsLoop) {
                        const rejoinIdx = getLoopIdleHeadIndex(coreLane);
                        moveToNearestPathTile(creep, coreLane, mission.id, {
                            preferredIndices: buildLoopPreferredIndices(rejoinIdx, coreLane.path.length)
                        });
                    } else {
                        moveToNearestPathTile(creep, coreLane, mission.id, { preferredIndices: [0] });
                    }
                    if (coreLaneIsLoop) logCoreLaneDebug(creep, mission, 'loop DELIVER core off-lane -> move_to_path');
                    return;
                }

                if (indexHasEnergyDemand(coreLane, idx, { ignoreSpawn: ignoreSpawnDemand }) && (creep.store[RESOURCE_ENERGY] || 0) > 0) {
                    const didTransfer = transferEnergyAtCurrentIndex(creep, coreLane, { ignoreSpawn: ignoreSpawnDemand });
                    if (coreLaneIsLoop) {
                        logCoreLaneDebug(
                            creep,
                            mission,
                            `loop DELIVER core idx=${idx} transferAtIndex=${didTransfer ? 1 : 0} carry=${creep.store[RESOURCE_ENERGY] || 0}`
                        );
                    }
                    return;
                }

                if (!laneHasEnergyDemand(coreLane, { ignoreSpawn: ignoreSpawnDemand })) {
                    creep.memory.coreLaneState = STATE_RETURN;
                    return;
                }

                if (idx >= endIndex && !coreLaneIsLoop) {
                    creep.memory.coreLaneState = STATE_RETURN;
                    return;
                }

                let moveResult;
                if (coreLaneIsLoop) {
                    const targetDemandIndex = getNearestDemandIndexOnLoop(creep, coreLane, RESOURCE_ENERGY);
                    if (targetDemandIndex >= 0) {
                        moveResult = stepTowardLoopIndex(creep, coreLane, targetDemandIndex, mission.id, runtime);
                    } else {
                        moveResult = stepTowardLoopIndex(creep, coreLane, 0, mission.id, runtime);
                    }
                    logCoreLaneDebug(
                        creep,
                        mission,
                        `loop DELIVER core move=${moveResult} idx=${idx} targetIdx=${targetDemandIndex}`
                    );
                } else {
                    moveResult = stepTowardIndex(creep, coreLane, endIndex, mission.id, runtime);
                }
                return;
            }

            if (!activeJob) {
                creep.memory.coreLaneState = STATE_RETURN;
                return;
            }

            const resourceType = activeJob.resourceType;
            const lane = getLaneRuntime(runtime, activeJob.pathKey) || coreLane;
            const target = Game.getObjectById(activeJob.targetId);
            const carried = creep.store[resourceType] || 0;
            if (!target || !target.store || target.store.getFreeCapacity(resourceType) <= 0 || carried <= 0) {
                creep.memory.coreLaneState = STATE_RETURN;
                return;
            }

            if (!creep.pos.inRangeTo(target, 1)) {
                if (Number.isInteger(activeJob.targetIndex) && activeJob.targetIndex >= 0) {
                    const laneLoop = lane && lane.isLoop === true;
                    const moveResult = laneLoop
                        ? stepTowardLoopIndex(creep, lane, activeJob.targetIndex, mission.id, runtime)
                        : stepTowardIndex(creep, lane, activeJob.targetIndex, mission.id, runtime);
                    if (coreLaneIsLoop) {
                        logCoreLaneDebug(
                            creep,
                            mission,
                            `loop DELIVER job->target move=${moveResult} idx=${getCurrentIndex(creep, lane)} ` +
                            `targetIdx=${activeJob.targetIndex} target=${activeJob.targetId}`
                        );
                    }
                    const idx = getCurrentIndex(creep, lane);
                    if (idx === activeJob.targetIndex) {
                        creep.moveTo(target, { range: 1, reusePath: 3 });
                    }
                } else {
                    creep.moveTo(target, { range: 1, reusePath: 3 });
                }
                return;
            }

            const transferCode = creep.transfer(target, resourceType);
            logCoreLaneDebug(
                creep,
                mission,
                `DELIVER transfer target=${target.id} res=${resourceType} code=${transferCode} ` +
                `targetFree=${target.store.getFreeCapacity(resourceType) || 0} carry=${creep.store[resourceType] || 0}`
            );
            if ((creep.store[resourceType] || 0) <= 0) {
                const stillRunnable = isJobRunnable(activeJob, 0);
                creep.memory.coreLaneState = stillRunnable ? STATE_LOAD : STATE_RETURN;
                if (!stillRunnable) clearJobMemory(creep);
            }
            return;
        }

        if (creep.memory.coreLaneState === STATE_RETURN) {
            const idx = getCurrentIndex(creep, coreLane);
            if (idx < 0) {
                if (coreLaneIsLoop) {
                    moveToNearestPathTile(creep, coreLane, mission.id, {
                        preferredIndices: buildLoopPreferredIndices(0, coreLane.path.length)
                    });
                } else {
                    moveToNearestPathTile(creep, coreLane, mission.id, { preferredIndices: [0] });
                }
                return;
            }

            if (idx > 0) {
                if (coreLaneIsLoop) {
                    stepTowardLoopIndex(creep, coreLane, 0, mission.id, runtime);
                } else {
                    stepTowardIndex(creep, coreLane, 0, mission.id, runtime);
                }
                return;
            }

            if (dumpNonJobCargo(creep, mission, runtime, null)) return;
            clearJobMemory(creep);
            creep.memory.coreLaneState = STATE_LOAD;
        }
    }
};
