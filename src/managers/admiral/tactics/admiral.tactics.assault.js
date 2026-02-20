/**
 * Admiral Assault Tactics: flag-centric engagement helpers.
 */
const ASSAULT_RANGE = 1;
const TOWER_DAMAGE_CLOSE = 600;
const TOWER_DAMAGE_FAR = 150;
const TOWER_CLOSE_RANGE = 5;
const TOWER_FAR_RANGE = 20;
const ATTACK_DAMAGE = 30;
const RANGED_ATTACK_DAMAGE = 10;
const DEFAULT_RETREAT_AT = 0.6;
const DEFAULT_REENGAGE_AT = 0.9;
const DEFAULT_DAMAGE_BUFFER = 50;
const DEFAULT_DANGER_RADIUS = 6;
const DEFAULT_SAFE_DAMAGE_RATIO = 0.5;
const DEFAULT_SUPPORT_RANGE = 1;
const DUO_STUCK_TICKS = 2;
const DUO_BLOCKED_TICKS = 2;
const DUO_BREAK_TICKS = 3;
const DEFAULT_KITE_RANGE = 3;
const DEFAULT_KITE_TRIGGER_RANGE = 3;
const DEFAULT_HEAL_KITE_TRIGGER_RANGE = 3;
const DEFAULT_SWAMP_KITE_BUFFER = 4;
const DEFAULT_KITE_AVOID_SWAMP = true;
const DEFAULT_KITE_AVOID_BORDERS = true;
const DUO_MIN_MELEE_RANGE = 2;

function shouldDebugAssault(creep, data) {
    if (data && data.debugAssault) return true;
    if (creep && creep.memory && creep.memory.debugAssault) return true;
    if (Memory && Memory.debugAssault) return true;
    return false;
}

function logAssault(creep, data, msg, extra) {
    if (!shouldDebugAssault(creep, data)) return;
    const name = creep && creep.name ? creep.name : 'unknown';
    const prefix = `[assault:${Game.time}] ${name} `;
    if (!extra) {
        console.log(prefix + msg);
        return;
    }
    try {
        console.log(prefix + msg + ' ' + JSON.stringify(extra));
    } catch (err) {
        console.log(prefix + msg);
    }
}

function getAssaultSquadMemory() {
    if (!Memory) return null;
    if (!Memory.military) Memory.military = {};
    if (!Memory.military.assaultSquads) Memory.military.assaultSquads = {};
    return Memory.military.assaultSquads;
}

function getAssaultSquadState(squadKey) {
    if (!squadKey || !Memory || !Memory.military || !Memory.military.assaultSquads) return null;
    return Memory.military.assaultSquads[squadKey] || null;
}

function markAssaultSquadStarted(squadKey, leader, support) {
    if (!squadKey || !leader || !support) return;
    const squads = getAssaultSquadMemory();
    if (!squads) return;
    const state = squads[squadKey] || {};
    if (!state.started) state.startedAt = Game.time;
    state.started = true;
    state.leaderName = leader.name;
    state.supportName = support.name;
    state.lastSeen = Game.time;
    squads[squadKey] = state;
}

function isAssaultSquadLocked(squadKey, liveCount) {
    if (!squadKey) return false;
    const state = getAssaultSquadState(squadKey);
    if (!state || !state.started) return false;
    if (!Number.isFinite(liveCount) || liveCount <= 0) return false;
    return true;
}

function isAlly(owner) {
    if (!owner || !owner.username) return false;
    if (!Array.isArray(Memory.allies)) return false;
    const name = ('' + owner.username).toLowerCase();
    return Memory.allies.some(a => ('' + a).toLowerCase() === name);
}

function getHostiles(room) {
    if (!room) return [];
    const hostiles = room.find(FIND_HOSTILE_CREEPS) || [];
    return hostiles.filter(h => h && !isAlly(h.owner));
}

function isDangerCreep(creep) {
    if (!creep) return false;
    return creep.getActiveBodyparts(ATTACK) > 0 || creep.getActiveBodyparts(RANGED_ATTACK) > 0;
}

function getAssaultLeader(squad) {
    if (!Array.isArray(squad) || squad.length === 0) return null;
    const explicit = squad.filter(c => c && c.memory && c.memory.assaultRole === 'leader');
    if (explicit.length > 0) {
        explicit.sort((a, b) => ('' + a.name).localeCompare('' + b.name));
        return explicit[0];
    }
    const sorted = squad.slice().sort((a, b) => ('' + a.name).localeCompare('' + b.name));
    return sorted[0] || null;
}

function getMissionSquad(creep, squadKey, roomName) {
    if (!creep) return [creep];
    const key = squadKey || (creep.memory ? creep.memory.missionName : null);
    if (!key) return [creep];
    return Object.values(Game.creeps).filter(c =>
        c && c.my &&
        c.memory &&
        c.memory.assaultSquad === key &&
        c.pos &&
        c.pos.roomName === (roomName || creep.pos.roomName)
    );
}

function getMissionSquadAll(squadKey) {
    if (!squadKey) return [];
    return Object.values(Game.creeps).filter(c =>
        c && c.my &&
        c.memory &&
        c.memory.assaultSquad === squadKey &&
        c.pos
    );
}

function getSquadPartner(creep, squad) {
    if (!creep || !Array.isArray(squad)) return null;
    return squad.find(c => c && c.id !== creep.id) || null;
}

function isDuoAssembled(squad, leader, waitPos, supportRange) {
    if (!waitPos || !Array.isArray(squad) || squad.length < 2) return false;
    if (!leader || !leader.pos) return false;
    const supporter = squad.find(c => c && c.id !== leader.id);
    if (!supporter || !supporter.pos) return false;
    if (leader.pos.roomName !== waitPos.roomName || supporter.pos.roomName !== waitPos.roomName) return false;
    const assembleRange = Math.max(1, Math.floor(supportRange || 1));
    const pairRange = getRange(leader.pos, supporter.pos);
    if (pairRange > assembleRange) return false;
    return true;
}

function getHealPerTickFromCreep(creep, range) {
    if (!creep) return 0;
    const healParts = creep.getActiveBodyparts(HEAL);
    if (healParts <= 0) return 0;
    if (range <= 1) return healParts * 12;
    if (range <= 3) return healParts * 4;
    return 0;
}

function getSquadHealPerTick(creep, squad) {
    if (!creep) return 0;
    let total = getHealPerTickFromCreep(creep, 0);
    if (!Array.isArray(squad)) return total;
    for (const ally of squad) {
        if (!ally || ally.id === creep.id) continue;
        const range = getRange(creep.pos, ally.pos);
        total += getHealPerTickFromCreep(ally, range);
    }
    return total;
}

function getRange(a, b) {
    if (!a || !b) return Infinity;
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function toPlainPos(pos) {
    if (!pos) return null;
    return { x: pos.x, y: pos.y, roomName: pos.roomName };
}

function escapeRegex(text) {
    return ('' + text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getAssaultWaypointFlags(baseName) {
    if (!baseName || !Game || !Game.flags) return [];
    const cache = global._assaultWaypointCache;
    if (cache && cache.time === Game.time && cache.baseName === baseName) return cache.flags;

    const pattern = new RegExp(`^${escapeRegex(baseName)}(\\d+)$`);
    const flags = Object.values(Game.flags)
        .map(flag => {
            if (!flag || !flag.name) return null;
            const match = flag.name.match(pattern);
            if (!match) return null;
            const index = Number.parseInt(match[1], 10);
            if (!Number.isFinite(index)) return null;
            return { flag, index, name: flag.name, pos: toPlainPos(flag.pos) };
        })
        .filter(entry => entry)
        .sort((a, b) => (a.index - b.index) || ('' + a.name).localeCompare('' + b.name));

    const result = { time: Game.time, baseName, flags };
    global._assaultWaypointCache = result;
    return flags;
}

function getAssaultWaypointSignature(waypoints) {
    if (!Array.isArray(waypoints) || waypoints.length === 0) return '';
    return waypoints.map(w => w && w.name).filter(n => n).join('|');
}

function isWaypointReached(leader, partner, waypoint, supportRange) {
    if (!waypoint || !waypoint.pos) return false;
    if (!leader || !leader.pos) return false;
    if (leader.pos.roomName !== waypoint.pos.roomName) return false;
    if (getRange(leader.pos, waypoint.pos) > 1) return false;
    if (partner) {
        if (!partner.pos || partner.pos.roomName !== waypoint.pos.roomName) return false;
        if (getRange(partner.pos, waypoint.pos) > 1) return false;
        const range = Math.max(1, Math.floor(supportRange || 1));
        if (getRange(leader.pos, partner.pos) > range) return false;
    }
    return true;
}

function resolveAssaultWaypointState(creep, leader, partner, waypoints, supportRange, allowAdvance) {
    if (!Array.isArray(waypoints) || waypoints.length === 0) {
        return { index: 0, waypoint: null, completed: true, signature: '' };
    }

    const owner = leader || creep;
    if (!owner || !owner.memory) {
        return { index: 0, waypoint: waypoints[0], completed: false, signature: getAssaultWaypointSignature(waypoints) };
    }

    const signature = getAssaultWaypointSignature(waypoints);
    if (owner.memory._assaultWaypointSig !== signature) {
        owner.memory._assaultWaypointSig = signature;
        owner.memory._assaultWaypointIndex = 0;
    }

    let index = Number.isFinite(owner.memory._assaultWaypointIndex) ? owner.memory._assaultWaypointIndex : 0;
    if (index < 0) index = 0;
    if (index > waypoints.length) index = waypoints.length;

    if (allowAdvance !== false) {
        const current = index < waypoints.length ? waypoints[index] : null;
        if (current && isWaypointReached(leader || creep, partner, current, supportRange)) {
            index += 1;
        }
    }

    owner.memory._assaultWaypointIndex = index;
    owner.memory._assaultWaypointSig = signature;
    if (leader && leader.memory) {
        leader.memory._assaultWaypointIndex = index;
        leader.memory._assaultWaypointSig = signature;
    }
    if (partner && partner.memory) {
        partner.memory._assaultWaypointIndex = index;
        partner.memory._assaultWaypointSig = signature;
    }

    const waypoint = index < waypoints.length ? waypoints[index] : null;
    return { index, waypoint, completed: index >= waypoints.length, signature };
}

function samePos(a, b) {
    if (!a || !b) return false;
    return a.x === b.x && a.y === b.y && a.roomName === b.roomName;
}

function isBorderPos(pos) {
    if (!pos) return false;
    return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
}

function isSwamp(room, x, y) {
    if (!room) return false;
    const terrain = room.getTerrain().get(x, y);
    return terrain === TERRAIN_MASK_SWAMP;
}

function getMoveTerrainCost(room, x, y) {
    if (!room) return Infinity;
    const terrain = room.getTerrain().get(x, y);
    if (terrain === TERRAIN_MASK_WALL) return Infinity;
    const structures = room.lookForAt(LOOK_STRUCTURES, x, y);
    for (const structure of structures) {
        if (structure && structure.structureType === STRUCTURE_ROAD) return 1;
    }
    if (terrain === TERRAIN_MASK_SWAMP) return 10;
    return 2;
}

function predictWillHaveFatigueNextTick(creep, room, fromPos, toPos) {
    if (!toPos || (fromPos && samePos(fromPos, toPos))) return false;
    if (!creep) return false;
    if (creep.fatigue > 0) return true;
    const moveParts = creep.getActiveBodyparts(MOVE);
    const totalParts = creep.body ? creep.body.length : 0;
    const terrainCost = getMoveTerrainCost(room, toPos.x, toPos.y);
    if (!Number.isFinite(terrainCost)) return true;
    if (terrainCost === 1) return moveParts === 0;
    if (terrainCost === 10) return moveParts * 2 < totalParts;
    return moveParts * 2 < totalParts;
}

function predictDuoFatigueSync(leader, support, room, leaderFrom, leaderTo, supportFrom, supportTo) {
    const leaderMoving = !!(leaderTo && (!leaderFrom || !samePos(leaderFrom, leaderTo)));
    const supportMoving = !!(supportTo && (!supportFrom || !samePos(supportFrom, supportTo)));
    const leaderWillFatigue = predictWillHaveFatigueNextTick(leader, room, leaderFrom, leaderTo);
    const supportWillFatigue = predictWillHaveFatigueNextTick(support, room, supportFrom, supportTo);
    const bothMoving = leaderMoving && supportMoving;
    const bothFatigue = leaderWillFatigue && supportWillFatigue;
    const bothNotFatigue = !leaderWillFatigue && !supportWillFatigue;
    const syncOk = !bothMoving || bothFatigue || bothNotFatigue;
    return { leaderWillFatigue, supportWillFatigue, syncOk };
}

function getAdjacentCandidates(pos, includeStay) {
    if (!pos) return [];
    const candidates = [];
    if (includeStay) {
        candidates.push({ x: pos.x, y: pos.y, roomName: pos.roomName });
    }
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            candidates.push({ x: pos.x + dx, y: pos.y + dy, roomName: pos.roomName });
        }
    }
    return candidates;
}

function getNearestMeleeHostile(pos, hostiles) {
    if (!pos || !Array.isArray(hostiles) || hostiles.length === 0) return null;
    let best = null;
    let bestRange = Infinity;
    for (const hostile of hostiles) {
        if (!hostile || !hostile.pos) continue;
        if (hostile.getActiveBodyparts(ATTACK) <= 0) continue;
        const range = getRange(pos, hostile.pos);
        if (range < bestRange) {
            bestRange = range;
            best = hostile;
        }
    }
    if (!best) return null;
    return { hostile: best, range: bestRange };
}

function scoreKiteStep(step, meleeHostile, context) {
    if (!step || !meleeHostile || !meleeHostile.pos) return null;
    const {
        room,
        hostiles,
        towers,
        currentRange,
        kiteRange,
        avoidBorders,
        avoidSwamp,
        swampBuffer,
        requireNonDecreasingRange
    } = context || {};
    const stepRange = getRange(step, meleeHostile.pos);
    if (stepRange <= 1) return null;
    if (avoidBorders && isBorderPos(step)) return null;
    const isSwampTile = room ? isSwamp(room, step.x, step.y) : false;
    if (avoidSwamp && isSwampTile && stepRange < swampBuffer) return null;
    if (requireNonDecreasingRange && Number.isFinite(currentRange) && stepRange < currentRange) return null;

    const desiredRange = Number.isFinite(kiteRange) ? kiteRange : DEFAULT_KITE_RANGE;
    let rangePenalty = 0;
    if (stepRange < desiredRange) {
        rangePenalty += (desiredRange - stepRange) * 1000;
    }
    const incomingDamage = getExpectedIncomingDamage(step, hostiles || [], towers || [], { rangeBuffer: 1 });
    const swampPenalty = isSwampTile ? 25 : 0;
    return rangePenalty + incomingDamage + swampPenalty;
}

function getKiteStep(creep, meleeHostile, context) {
    if (!creep || !creep.pos || !meleeHostile || !meleeHostile.pos) return null;
    const {
        room,
        hostiles,
        towers,
        kiteRange,
        avoidBorders,
        avoidSwamp,
        swampBuffer,
        requireNonDecreasingRange,
        includeStay
    } = context || {};
    if (!room) return null;
    const candidates = getAdjacentCandidates(creep.pos, includeStay !== false);
    const squadIds = new Set([creep.id]);
    const currentRange = getRange(creep.pos, meleeHostile.pos);
    let best = null;
    let bestScore = Infinity;

    for (const step of candidates) {
        if (!step) continue;
        if (step.roomName !== creep.pos.roomName) continue;
        if (step.x < 0 || step.x > 49 || step.y < 0 || step.y > 49) continue;
        if (!samePos(step, creep.pos) && !isWalkableForSquad(room, step.x, step.y, squadIds)) continue;
        const score = scoreKiteStep(step, meleeHostile, {
            room,
            hostiles,
            towers,
            currentRange,
            kiteRange: Number.isFinite(kiteRange) ? kiteRange : DEFAULT_KITE_RANGE,
            avoidBorders: avoidBorders !== false && DEFAULT_KITE_AVOID_BORDERS,
            avoidSwamp: avoidSwamp !== false && DEFAULT_KITE_AVOID_SWAMP,
            swampBuffer: Number.isFinite(swampBuffer) ? swampBuffer : DEFAULT_SWAMP_KITE_BUFFER,
            requireNonDecreasingRange: !!requireNonDecreasingRange
        });
        if (score === null) continue;
        if (score < bestScore) {
            bestScore = score;
            best = step;
        }
    }

    return best;
}

function getDuoKiteStep(leader, support, room, hostiles, towers, supportRange, options) {
    if (!leader || !support || !room) return null;
    if (!leader.pos || !support.pos) return null;
    const meleeHostile = options && options.meleeHostile ? options.meleeHostile : null;
    if (!meleeHostile || !meleeHostile.pos) return null;

    const avoidBorders = options && options.avoidBorders !== false && DEFAULT_KITE_AVOID_BORDERS;
    const avoidSwamp = options && options.avoidSwamp !== false && DEFAULT_KITE_AVOID_SWAMP;
    const kiteRange = Number.isFinite(options && options.kiteRange) ? options.kiteRange : DEFAULT_KITE_RANGE;
    const swampBuffer = Number.isFinite(options && options.swampBuffer) ? options.swampBuffer : DEFAULT_SWAMP_KITE_BUFFER;
    const requireNonDecreasingRange = !!(options && options.requireNonDecreasingRange);
    const currentRange = getRange(leader.pos, meleeHostile.pos);
    const rangeLimit = Math.max(1, Math.floor(supportRange || 1));
    const squadIds = new Set([leader.id, support.id]);
    const currentTowerDamage = getTowerDamageAtPos(leader.pos, towers);
    const supportAdjacent = getAdjacentCandidates(support.pos, true);

    const candidates = getAdjacentCandidates(leader.pos, false);
    let best = null;
    let bestScore = Infinity;

    for (const step of candidates) {
        if (!step) continue;
        if (step.roomName !== leader.pos.roomName) continue;
        if (step.x < 0 || step.x > 49 || step.y < 0 || step.y > 49) continue;
        if (!isWalkableForSquad(room, step.x, step.y, squadIds)) continue;

        const stepRange = getRange(step, meleeHostile.pos);
        if (stepRange <= DUO_MIN_MELEE_RANGE) continue;
        if (avoidBorders && isBorderPos(step)) continue;
        const leaderSwamp = avoidSwamp && isSwamp(room, step.x, step.y);
        if (leaderSwamp && stepRange < swampBuffer) continue;
        if (requireNonDecreasingRange && Number.isFinite(currentRange) && stepRange < currentRange) continue;

        let baseScore = 0;
        if (stepRange < kiteRange) {
            baseScore += (kiteRange - stepRange) * 1000;
        }
        baseScore += getExpectedIncomingDamage(step, hostiles || [], towers || [], { rangeBuffer: 1 });
        if (leaderSwamp) baseScore += 25;

        const towerDamageStep = getTowerDamageAtPos(step, towers);
        if (towerDamageStep > currentTowerDamage) {
            baseScore += (towerDamageStep - currentTowerDamage) * 0.5;
        }

        const vacatedPos = (!samePos(step, leader.pos))
            ? { x: leader.pos.x, y: leader.pos.y, roomName: leader.pos.roomName }
            : null;
        const vacatedKey = vacatedPos ? (vacatedPos.x * 50) + vacatedPos.y : null;

        let bestSupport = null;
        let bestSupportScore = Infinity;
        for (const supportStep of supportAdjacent) {
            if (!supportStep) continue;
            if (supportStep.roomName !== support.pos.roomName) continue;
            if (supportStep.x < 0 || supportStep.x > 49 || supportStep.y < 0 || supportStep.y > 49) continue;
            if (!isWalkableForSquad(room, supportStep.x, supportStep.y, squadIds)) continue;
            if (getRange(step, supportStep) > rangeLimit) continue;
            if (avoidBorders && isBorderPos(supportStep)) continue;

            const supportRangeToMelee = getRange(supportStep, meleeHostile.pos);
            if (supportRangeToMelee <= DUO_MIN_MELEE_RANGE) continue;
            const supportSwamp = avoidSwamp && isSwamp(room, supportStep.x, supportStep.y);
            if (supportSwamp && supportRangeToMelee < swampBuffer) continue;

            let supportScore = 0;
            if (supportRangeToMelee < stepRange) {
                supportScore += (stepRange - supportRangeToMelee) * 100;
            }
            supportScore += Math.abs(supportRangeToMelee - stepRange) * 25;
            if (supportSwamp) supportScore += 15;
            if (vacatedKey !== null && (supportStep.x * 50) + supportStep.y === vacatedKey) {
                supportScore -= 0.5;
            }

            if (supportScore < bestSupportScore) {
                bestSupportScore = supportScore;
                bestSupport = supportStep;
            }
        }

        if (!bestSupport) {
            // Allow leader-only step if still safe
            bestSupport = support.pos;
        }
        const score = baseScore + bestSupportScore;
        if (score < bestScore) {
            bestScore = score;
            best = { leaderStep: step, supportStep: bestSupport };
        }
    }

    return best;
}

function isDuoInRoomInterior(leader, partner, roomName) {
    if (!leader || !partner || !roomName) return false;
    if (!leader.pos || !partner.pos) return false;
    if (leader.pos.roomName !== roomName || partner.pos.roomName !== roomName) return false;
    return !isBorderPos(leader.pos) && !isBorderPos(partner.pos);
}

function isPassableStructure(structure) {
    if (!structure) return true;
    if (structure.structureType === STRUCTURE_ROAD) return true;
    if (structure.structureType === STRUCTURE_CONTAINER) return true;
    if (structure.structureType === STRUCTURE_RAMPART && (structure.my || structure.isPublic)) return true;
    return false;
}

function isWalkableForSquad(room, x, y, squadIds) {
    if (!room) return false;
    if (x < 0 || x > 49 || y < 0 || y > 49) return false;
    const terrain = room.getTerrain().get(x, y);
    if (terrain === TERRAIN_MASK_WALL) return false;
    const structures = room.lookForAt(LOOK_STRUCTURES, x, y);
    for (const structure of structures) {
        if (!isPassableStructure(structure)) return false;
    }
    const creeps = room.lookForAt(LOOK_CREEPS, x, y);
    for (const creep of creeps) {
        if (!squadIds || !squadIds.has(creep.id)) return false;
    }
    return true;
}

function getFormationOffset(leaderPos, supportPos, supportRange) {
    if (!leaderPos || !supportPos) return null;
    const dx = supportPos.x - leaderPos.x;
    const dy = supportPos.y - leaderPos.y;
    const range = Math.max(1, Math.floor(supportRange || 1));
    if (Math.max(Math.abs(dx), Math.abs(dy)) > range) return null;
    return { dx, dy };
}

function getSupportStepForLeaderMove(leaderStep, leaderPos, supportPos, room, supportRange, squadIds) {
    if (!leaderStep || !leaderPos || !supportPos || !room) return null;
    const range = Math.max(1, Math.floor(supportRange || 1));
    const offset = getFormationOffset(leaderPos, supportPos, range);
    const ideal = offset ? { x: leaderStep.x + offset.dx, y: leaderStep.y + offset.dy } : null;
    let best = null;
    let bestScore = Infinity;
    const vacatedKey = leaderPos && !samePos(leaderStep, leaderPos)
        ? (leaderPos.x * 50) + leaderPos.y
        : null;
    const vacatedPos = vacatedKey !== null
        ? { x: leaderPos.x, y: leaderPos.y, roomName: leaderPos.roomName || leaderStep.roomName || room.name }
        : null;
    if (vacatedPos &&
        isWalkableForSquad(room, vacatedPos.x, vacatedPos.y, squadIds) &&
        getRange(vacatedPos, supportPos) <= 1 &&
        getRange(vacatedPos, leaderStep) <= range) {
        return vacatedPos;
    }

    for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) {
            if (dx === 0 && dy === 0) continue;
            if (Math.max(Math.abs(dx), Math.abs(dy)) > range) continue;
            const x = leaderStep.x + dx;
            const y = leaderStep.y + dy;
            if (x < 0 || x > 49 || y < 0 || y > 49) continue;
            if (!isWalkableForSquad(room, x, y, squadIds)) continue;
            const candidate = { x, y, roomName: leaderStep.roomName || room.name };
            if (getRange(candidate, supportPos) > 1) continue;
            let score = getRange(candidate, supportPos);
            if (ideal) score += Math.abs(candidate.x - ideal.x) + Math.abs(candidate.y - ideal.y);
            if (vacatedKey !== null && (candidate.x * 50) + candidate.y === vacatedKey) {
                score -= 0.5;
            }
            if (score < bestScore) {
                bestScore = score;
                best = candidate;
            }
        }
    }

    return best;
}

function getSupportCatchUpStep(support, leaderPos, supportRange, room, hostiles, towers, options) {
    if (!support || !leaderPos || !room) return null;
    const range = Math.max(1, Math.floor(supportRange || 1));
    if (getRange(support.pos, leaderPos) <= range) return support.pos;
    const ignoreDanger = options && options.ignoreDanger;
    const step = getApproachStep(
        support,
        leaderPos,
        range,
        room,
        ignoreDanger ? [] : hostiles,
        ignoreDanger ? [] : towers
    );
    if (!step) return support.pos;
    const currentRange = getRange(support.pos, leaderPos);
    const nextRange = getRange(step, leaderPos);
    if (nextRange > currentRange) return support.pos;
    return step;
}

function selectHealTarget(creep, squad) {
    if (!creep || creep.getActiveBodyparts(HEAL) <= 0) return null;
    const candidates = (Array.isArray(squad) ? squad : [creep]).filter(c => c && c.hits < c.hitsMax);
    if (candidates.length === 0) return null;

    const sortByNeed = (a, b) => {
        const ar = a.hits / a.hitsMax;
        const br = b.hits / b.hitsMax;
        if (ar !== br) return ar - br;
        return getRange(creep.pos, a.pos) - getRange(creep.pos, b.pos);
    };

    const adjacent = candidates.filter(c => getRange(creep.pos, c.pos) <= 1);
    if (adjacent.length > 0) return adjacent.sort(sortByNeed)[0];
    const ranged = candidates.filter(c => getRange(creep.pos, c.pos) <= 3);
    if (ranged.length > 0) return ranged.sort(sortByNeed)[0];

    return candidates.sort(sortByNeed)[0];
}

function getTowerDamageAtRange(range) {
    if (!Number.isFinite(range)) return 0;
    if (range <= TOWER_CLOSE_RANGE) return TOWER_DAMAGE_CLOSE;
    if (range >= TOWER_FAR_RANGE) return TOWER_DAMAGE_FAR;
    return TOWER_DAMAGE_CLOSE - (range - TOWER_CLOSE_RANGE) * 30;
}

function getHostileTowers(room) {
    if (!room) return [];
    return room.find(FIND_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_TOWER && s.owner && !s.my && !isAlly(s.owner)
    });
}

function getTowerDamageAtPos(pos, towers) {
    if (!pos || !Array.isArray(towers) || towers.length === 0) return 0;
    let total = 0;
    for (const tower of towers) {
        if (!tower || !tower.pos) continue;
        if (tower.store && tower.store[RESOURCE_ENERGY] <= 0) continue;
        if (typeof tower.energy === 'number' && tower.energy <= 0) continue;
        const range = getRange(pos, tower.pos);
        total += getTowerDamageAtRange(range);
    }
    return total;
}

function getHostileMeleeDamageAtPos(pos, hostiles, rangeBuffer) {
    if (!pos || !Array.isArray(hostiles) || hostiles.length === 0) return 0;
    const buffer = Number.isFinite(rangeBuffer) ? rangeBuffer : 0;
    let total = 0;
    for (const hostile of hostiles) {
        if (!hostile || !hostile.pos) continue;
        const range = getRange(pos, hostile.pos);
        if (range <= 1 + buffer) {
            total += hostile.getActiveBodyparts(ATTACK) * ATTACK_DAMAGE;
        }
    }
    return total;
}

function getHostileRangedDamageAtPos(pos, hostiles, rangeBuffer) {
    if (!pos || !Array.isArray(hostiles) || hostiles.length === 0) return 0;
    const buffer = Number.isFinite(rangeBuffer) ? rangeBuffer : 0;
    let total = 0;
    for (const hostile of hostiles) {
        if (!hostile || !hostile.pos) continue;
        const range = getRange(pos, hostile.pos);
        if (range <= 3 + buffer) {
            total += hostile.getActiveBodyparts(RANGED_ATTACK) * RANGED_ATTACK_DAMAGE;
        }
    }
    return total;
}

function getHostileCreepDamageAtPos(pos, hostiles, options) {
    const buffer = options && Number.isFinite(options.rangeBuffer) ? options.rangeBuffer : 0;
    return getHostileMeleeDamageAtPos(pos, hostiles, buffer) + getHostileRangedDamageAtPos(pos, hostiles, buffer);
}

function getExpectedIncomingDamage(pos, hostiles, towers, options) {
    const towerDamage = getTowerDamageAtPos(pos, towers);
    const creepDamage = getHostileCreepDamageAtPos(pos, hostiles, options);
    return towerDamage + creepDamage;
}

function isAssaultStructure(structure) {
    if (!structure) return false;
    if ((structure.structureType === STRUCTURE_WALL) && !structure.owner) return true;
    if (structure.owner && !structure.my && !isAlly(structure.owner)) return true;
    return false;
}

function resolveAssaultStructureTarget(flag) {
    if (!flag || !flag.pos) return null;
    const room = Game.rooms[flag.pos.roomName];
    if (!room) return null;

    const underFlag = room.lookForAt(LOOK_STRUCTURES, flag.pos.x, flag.pos.y) || [];
    const hostileUnderFlag = underFlag
        .filter(s => isAssaultStructure(s));
    if (hostileUnderFlag.length > 0) {
        hostileUnderFlag.sort((a, b) => {
            const pa = getStructurePriority(a);
            const pb = getStructurePriority(b);
            if (pa !== pb) return pa - pb;
            return a.hits - b.hits;
        });
        return hostileUnderFlag[0];
    }

    const x = flag.pos.x;
    const y = flag.pos.y;
    const top = Math.max(0, y - 1);
    const left = Math.max(0, x - 1);
    const bottom = Math.min(49, y + 1);
    const right = Math.min(49, x + 1);

    const structures = room.lookForAtArea(LOOK_STRUCTURES, top, left, bottom, right, true) || [];
    const hostileStructures = structures
        .map(entry => entry && entry.structure)
        .filter(s => isAssaultStructure(s));
    if (hostileStructures.length > 0) {
        hostileStructures.sort((a, b) => {
            const pa = getStructurePriority(a);
            const pb = getStructurePriority(b);
            if (pa !== pb) return pa - pb;
            return a.hits - b.hits;
        });
        return hostileStructures[0];
    }

    return null;
}

function getStructurePriority(structure) {
    if (!structure) return 99;
    switch (structure.structureType) {
        case STRUCTURE_TOWER: return 1;
        case STRUCTURE_SPAWN: return 2;
        case STRUCTURE_STORAGE: return 3;
        case STRUCTURE_TERMINAL: return 3;
        case STRUCTURE_EXTENSION: return 4;
        case STRUCTURE_LAB: return 4;
        case STRUCTURE_FACTORY: return 4;
        case STRUCTURE_LINK: return 5;
        case STRUCTURE_RAMPART: return 6;
        case STRUCTURE_WALL: return 7;
        default: return 5;
    }
}

function selectAssaultTarget(creep, attackFlag, hostiles, dangerRadius, options) {
    if (!creep) return null;
    const mode = options && options.mode;
    if (mode === 'dismantle') {
        return attackFlag ? resolveAssaultStructureTarget(attackFlag) : null;
    }
    const radius = Number.isFinite(dangerRadius) ? dangerRadius : DEFAULT_DANGER_RADIUS;
    const allHostiles = Array.isArray(hostiles) ? hostiles : [];
    const killboxHostiles = (attackFlag && attackFlag.pos)
        ? allHostiles.filter(h => h && h.pos && getRange(h.pos, attackFlag.pos) <= radius)
        : allHostiles;
    if (attackFlag && attackFlag.pos && killboxHostiles.length > 0) {
        const danger = killboxHostiles.filter(h => isDangerCreep(h));
        if (danger.length > 0) {
            return creep.pos.findClosestByRange(danger) || danger[0];
        }
    }

    const structureTarget = attackFlag ? resolveAssaultStructureTarget(attackFlag) : null;
    if (structureTarget) return structureTarget;

    if (killboxHostiles.length > 0) {
        return creep.pos.findClosestByRange(killboxHostiles) || killboxHostiles[0];
    }

    return null;
}

function addCost(costs, x, y, value) {
    if (x < 0 || x > 49 || y < 0 || y > 49) return;
    const current = costs.get(x, y);
    if (current === 0xff) return;
    const next = Math.min(254, current + value);
    costs.set(x, y, next);
}

function isPassableAtCost(costs, x, y, positions) {
    if (!costs) return false;
    if (x < 0 || x > 49 || y < 0 || y > 49) return false;
    if (Array.isArray(positions)) {
        for (const pos of positions) {
            if (pos && pos.x === x && pos.y === y) return true;
        }
    }
    return costs.get(x, y) !== 0xff;
}

function applyDuoCostMatrixTransform(costs, supportRange, positions) {
    if (!costs) return costs;
    const range = Math.max(1, Math.floor(supportRange || 1));
    if (Array.isArray(positions)) {
        for (const pos of positions) {
            if (!pos) continue;
            if (pos.x < 0 || pos.x > 49 || pos.y < 0 || pos.y > 49) continue;
            if (costs.get(pos.x, pos.y) === 0xff) {
                costs.set(pos.x, pos.y, 1);
            }
        }
    }
    for (let x = 0; x <= 49; x++) {
        for (let y = 0; y <= 49; y++) {
            if (!isPassableAtCost(costs, x, y, positions)) continue;
            let adj = 0;
            for (let dx = -range; dx <= range; dx++) {
                for (let dy = -range; dy <= range; dy++) {
                    if (dx === 0 && dy === 0) continue;
                    if (Math.max(Math.abs(dx), Math.abs(dy)) > range) continue;
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;
                    if (!isPassableAtCost(costs, nx, ny, positions)) continue;
                    adj++;
                    if (adj > 1) break;
                }
                if (adj > 1) break;
            }
            if (adj === 0) {
                costs.set(x, y, 0xff);
            }
        }
    }
    return costs;
}

function getAssaultCostMatrix(room, hostiles, towers) {
    if (!room) return new PathFinder.CostMatrix();
    const cache = global.getRoomCache(room);
    const costs = new PathFinder.CostMatrix();

    (cache.creeps || []).forEach(c => costs.set(c.pos.x, c.pos.y, 0xff));
    (cache.structures || []).forEach(s => {
        if (!s) return;
        if (s.structureType === STRUCTURE_ROAD) return;
        if (s.structureType === STRUCTURE_CONTAINER) return;
        if (s.structureType === STRUCTURE_RAMPART && (s.my || s.isPublic)) return;
        costs.set(s.pos.x, s.pos.y, 0xff);
    });

    if (Array.isArray(towers)) {
        for (const tower of towers) {
            if (!tower || !tower.pos) continue;
            const tx = tower.pos.x;
            const ty = tower.pos.y;
            const minX = Math.max(0, tx - TOWER_FAR_RANGE);
            const maxX = Math.min(49, tx + TOWER_FAR_RANGE);
            const minY = Math.max(0, ty - TOWER_FAR_RANGE);
            const maxY = Math.min(49, ty + TOWER_FAR_RANGE);
            for (let x = minX; x <= maxX; x++) {
                for (let y = minY; y <= maxY; y++) {
                    const range = Math.max(Math.abs(x - tx), Math.abs(y - ty));
                    if (range > TOWER_FAR_RANGE) continue;
                    const dmg = getTowerDamageAtRange(range);
                    const penalty = Math.max(1, Math.round(dmg / 30));
                    addCost(costs, x, y, penalty);
                }
            }
        }
    }

    if (Array.isArray(hostiles)) {
        for (const hostile of hostiles) {
            if (!hostile || !hostile.pos) continue;
            const hx = hostile.pos.x;
            const hy = hostile.pos.y;
            const hasMelee = hostile.getActiveBodyparts(ATTACK) > 0;
            const hasRanged = hostile.getActiveBodyparts(RANGED_ATTACK) > 0;
            if (!hasMelee && !hasRanged) continue;
            const rangeMax = hasRanged ? 3 : 2;
            const minX = Math.max(0, hx - rangeMax);
            const maxX = Math.min(49, hx + rangeMax);
            const minY = Math.max(0, hy - rangeMax);
            const maxY = Math.min(49, hy + rangeMax);
            for (let x = minX; x <= maxX; x++) {
                for (let y = minY; y <= maxY; y++) {
                    const range = Math.max(Math.abs(x - hx), Math.abs(y - hy));
                    if (hasMelee && range <= 1) addCost(costs, x, y, 20);
                    else if (hasMelee && range === 2) addCost(costs, x, y, 10);
                    if (hasRanged && range <= 3) addCost(costs, x, y, 15);
                }
            }
        }
    }

    return costs;
}

function getAssaultCostMatrixDuo(room, hostiles, towers, supportRange, positions) {
    const costs = getAssaultCostMatrix(room, hostiles, towers);
    return applyDuoCostMatrixTransform(costs, supportRange, positions);
}

function getApproachStep(creep, targetPos, range, room, hostiles, towers) {
    if (!creep || !targetPos || !room) return null;
    if (targetPos.roomName && targetPos.roomName !== room.name) return targetPos;
    if (creep.pos && creep.pos.getRangeTo(targetPos) <= range) return null;
    const search = PathFinder.search(creep.pos, { pos: targetPos, range: range }, {
        maxRooms: 1,
        roomCallback: () => getAssaultCostMatrix(room, hostiles, towers)
    });
    if (search.path && search.path.length > 0) return search.path[0];
    return null;
}

function getApproachStepDuo(creep, targetPos, range, room, hostiles, towers, supportRange, positions) {
    if (!creep || !targetPos || !room) return null;
    if (targetPos.roomName && targetPos.roomName !== room.name) return targetPos;
    if (creep.pos && creep.pos.getRangeTo(targetPos) <= range) return null;
    const search = PathFinder.search(creep.pos, { pos: targetPos, range: range }, {
        maxRooms: 1,
        roomCallback: () => getAssaultCostMatrixDuo(room, hostiles, towers, supportRange, positions)
    });
    if (search.path && search.path.length > 0) return search.path[0];
    return null;
}

function getRetreatStep(creep, room, hostiles, towers) {
    if (!creep || !room) return null;
    const fleeTargets = [];
    if (Array.isArray(hostiles)) {
        for (const hostile of hostiles) {
            if (!hostile || !hostile.pos) continue;
            fleeTargets.push({ pos: hostile.pos, range: 4 });
        }
    }
    if (Array.isArray(towers)) {
        for (const tower of towers) {
            if (!tower || !tower.pos) continue;
            fleeTargets.push({ pos: tower.pos, range: TOWER_FAR_RANGE });
        }
    }

    if (fleeTargets.length > 0) {
        const result = PathFinder.search(creep.pos, fleeTargets, {
            flee: true,
            maxRooms: 1,
            roomCallback: () => getAssaultCostMatrix(room, hostiles, towers)
        });
        if (result.path && result.path.length > 0) return result.path[0];
    }

    const exitPos = creep.pos.findClosestByRange(FIND_EXIT);
    return exitPos || null;
}

function getEntryPosForExit(exitPos, targetRoomName) {
    if (!exitPos || !targetRoomName) return null;
    let x = exitPos.x;
    let y = exitPos.y;
    if (exitPos.x === 0) x = 49;
    else if (exitPos.x === 49) x = 0;
    if (exitPos.y === 0) y = 49;
    else if (exitPos.y === 49) y = 0;
    return { x, y, roomName: targetRoomName };
}

function getExitPosToward(creep, targetRoomName, preferPos) {
    if (!creep || !targetRoomName) return null;
    if (!creep.room || creep.room.name === targetRoomName) return null;
    const exitDir = creep.room.findExitTo(targetRoomName);
    if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) return null;
    const exits = creep.room.find(exitDir);
    if (!Array.isArray(exits) || exits.length === 0) return null;
    const hasPrefer = preferPos && preferPos.roomName === targetRoomName;
    const resolvedPrefer = hasPrefer
        ? preferPos
        : { x: 25, y: 25, roomName: targetRoomName };

    let best = null;
    let bestDist = Infinity;
    let bestCreepDist = Infinity;
    for (const pos of exits) {
        if (!pos) continue;
        const entryPos = getEntryPosForExit(pos, targetRoomName);
        if (!entryPos) continue;
        const dist = getRange(entryPos, resolvedPrefer);
        const creepDist = getRange(creep.pos, pos);
        if (dist < bestDist || (dist === bestDist && creepDist < bestCreepDist)) {
            best = pos;
            bestDist = dist;
            bestCreepDist = creepDist;
        }
    }

    const selected = best || creep.pos.findClosestByRange(exits);
    if (selected) {
        console.log(`[assault:${Game.time}] exitToward`, JSON.stringify({
            creep: creep.name,
            fromRoom: creep.room.name,
            targetRoomName,
            preferPos: hasPrefer ? toPlainPos(preferPos) : null,
            resolvedPrefer,
            selectedExit: toPlainPos(selected)
        }));
    }
    return selected;
}

function resolveAssaultState(creep, incomingDamage, sustainableDamage, options) {
    if (!creep) return 'engage';
    const retreatAt = options && Number.isFinite(options.retreatAt) ? options.retreatAt : DEFAULT_RETREAT_AT;
    const reengageAt = options && Number.isFinite(options.reengageAt) ? options.reengageAt : DEFAULT_REENGAGE_AT;
    const safeDamageRatio = options && Number.isFinite(options.safeDamageRatio) ? options.safeDamageRatio : DEFAULT_SAFE_DAMAGE_RATIO;

    let state = creep.memory.assaultState || 'engage';
    if (state === 'engage') {
        if (creep.hits <= creep.hitsMax * retreatAt || incomingDamage > sustainableDamage) {
            state = 'retreat';
        }
    } else if (state === 'retreat') {
        if (incomingDamage <= sustainableDamage * safeDamageRatio) {
            state = 'heal';
        }
    } else if (state === 'heal') {
        if (incomingDamage > sustainableDamage) {
            state = 'retreat';
        } else if (creep.hits >= creep.hitsMax * reengageAt) {
            state = 'engage';
        }
    }

    return state;
}

function getAssaultMoveIntent(creep, context) {
    const {
        activeFlag,
        waitPos,
        targetRoomName,
        target,
        state,
        isLeader,
        leader,
        partner,
        supportRange,
        currentRoom,
        hostiles,
        towers,
        incomingDamage,
        sustainableDamage,
        safeDamageRatio,
        assaultRole,
        closeRangeStructures,
        ignoreCohesion
    } = context || {};

    let moveTarget = null;
    let range = ASSAULT_RANGE;
    let holdPosition = false;
    const partnerRoom = partner && partner.pos ? partner.pos.roomName : null;
    const leaderRoom = leader && leader.pos ? leader.pos.roomName : null;
    const needsCohesion = !ignoreCohesion && assaultRole !== 'solo' && currentRoom && partnerRoom && partnerRoom !== currentRoom.name;
    const duoReadyForExit = ignoreCohesion || assaultRole === 'solo' || !currentRoom || !leader || !partner
        ? true
        : isDuoInRoomInterior(leader, partner, currentRoom.name);
    const isSoloRanged = assaultRole === 'solo' && creep.getActiveBodyparts(RANGED_ATTACK) > 0;
    const meleeThreat = currentRoom ? getNearestMeleeHostile(creep.pos, hostiles) : null;
    const meleeHostile = meleeThreat ? meleeThreat.hostile : null;
    const meleeRange = meleeThreat ? meleeThreat.range : Infinity;

    if (!currentRoom) {
        moveTarget = activeFlag ? { x: activeFlag.pos.x, y: activeFlag.pos.y, roomName: activeFlag.pos.roomName } : null;
    } else if (needsCohesion && state !== 'retreat') {
        const targetRoom = targetRoomName || (activeFlag && activeFlag.pos ? activeFlag.pos.roomName : null);
        if (targetRoom) {
            if (currentRoom.name === targetRoom) {
                // Hold position on the target-room side until the partner crosses.
                holdPosition = true;
                moveTarget = null;
                range = 0;
            } else {
                const preferPos = activeFlag && activeFlag.pos && activeFlag.pos.roomName === targetRoom
                    ? activeFlag.pos
                    : null;
                const exitPos = getExitPosToward(creep, targetRoom, preferPos);
                if (exitPos) {
                    moveTarget = { x: exitPos.x, y: exitPos.y, roomName: exitPos.roomName };
                    range = 0;
                }
            }
        }
        if (!moveTarget && !holdPosition && waitPos) {
            moveTarget = { x: waitPos.x, y: waitPos.y, roomName: waitPos.roomName };
            range = 1;
        } else if (!moveTarget && !holdPosition && activeFlag) {
            moveTarget = { x: activeFlag.pos.x, y: activeFlag.pos.y, roomName: activeFlag.pos.roomName };
            range = ASSAULT_RANGE;
        }
    } else if (state === 'retreat') {
        const step = getRetreatStep(creep, currentRoom, hostiles, towers);
        // Allow retreat to border even when the duo is split to avoid deadlocks.
        if (step) {
            moveTarget = { x: step.x, y: step.y, roomName: step.roomName || currentRoom.name };
            range = 0;
        }
    } else if (state === 'heal') {
        if (isSoloRanged && meleeHostile && meleeRange <= DEFAULT_HEAL_KITE_TRIGGER_RANGE) {
            const step = getKiteStep(creep, meleeHostile, {
                room: currentRoom,
                hostiles,
                towers,
                kiteRange: DEFAULT_KITE_RANGE,
                avoidBorders: DEFAULT_KITE_AVOID_BORDERS,
                avoidSwamp: DEFAULT_KITE_AVOID_SWAMP,
                swampBuffer: DEFAULT_SWAMP_KITE_BUFFER,
                requireNonDecreasingRange: true,
                includeStay: true
            });
            if (step) {
                moveTarget = { x: step.x, y: step.y, roomName: step.roomName || currentRoom.name };
                range = 0;
                return { moveTarget, range };
            }
        }
        if (incomingDamage > sustainableDamage * safeDamageRatio) {
            let step = getRetreatStep(creep, currentRoom, hostiles, towers);
            if (step && meleeHostile && meleeRange <= 3 && isSwamp(currentRoom, step.x, step.y)) {
                const kiteStep = getKiteStep(creep, meleeHostile, {
                    room: currentRoom,
                    hostiles,
                    towers,
                    kiteRange: DEFAULT_KITE_RANGE,
                    avoidBorders: DEFAULT_KITE_AVOID_BORDERS,
                    avoidSwamp: DEFAULT_KITE_AVOID_SWAMP,
                    swampBuffer: DEFAULT_SWAMP_KITE_BUFFER,
                    requireNonDecreasingRange: true,
                    includeStay: true
                });
                if (kiteStep) step = kiteStep;
            }
            if (step && (duoReadyForExit || !isBorderPos(step))) {
                moveTarget = { x: step.x, y: step.y, roomName: step.roomName || currentRoom.name };
                range = 0;
            }
        } else if (!isLeader && leader && leader.pos && leader.pos.roomName === currentRoom.name) {
            let step = getApproachStep(creep, leader.pos, supportRange, currentRoom, hostiles, towers);
            if (step && meleeHostile && meleeRange <= 3 && isSwamp(currentRoom, step.x, step.y)) {
                const kiteStep = getKiteStep(creep, meleeHostile, {
                    room: currentRoom,
                    hostiles,
                    towers,
                    kiteRange: DEFAULT_KITE_RANGE,
                    avoidBorders: DEFAULT_KITE_AVOID_BORDERS,
                    avoidSwamp: DEFAULT_KITE_AVOID_SWAMP,
                    swampBuffer: DEFAULT_SWAMP_KITE_BUFFER,
                    requireNonDecreasingRange: true,
                    includeStay: true
                });
                if (kiteStep) step = kiteStep;
            }
            if (step) {
                moveTarget = { x: step.x, y: step.y, roomName: step.roomName || currentRoom.name };
                range = 0;
            }
        }
    } else if (!isLeader && leader) {
        if (leader.pos && leader.pos.roomName === currentRoom.name && getRange(creep.pos, leader.pos) > supportRange) {
            const step = getApproachStep(creep, leader.pos, supportRange, currentRoom, hostiles, towers);
            if (step) {
                moveTarget = { x: step.x, y: step.y, roomName: step.roomName || currentRoom.name };
                range = 0;
            }
        } else if (!moveTarget && leader.memory && leader.memory.task && leader.memory.task.moveTarget) {
            const leaderTarget = leader.memory.task.moveTarget;
            if (leaderTarget && leaderTarget.roomName === currentRoom.name) {
                moveTarget = { x: leaderTarget.x, y: leaderTarget.y, roomName: leaderTarget.roomName };
                range = Math.max(1, Math.floor(supportRange || 1));
            }
        }
    } else if (currentRoom && currentRoom.name !== targetRoomName) {
        const preferPos = activeFlag && activeFlag.pos && activeFlag.pos.roomName === targetRoomName
            ? activeFlag.pos
            : null;
        const exitPos = getExitPosToward(creep, targetRoomName, preferPos);
        if (exitPos) {
            moveTarget = { x: exitPos.x, y: exitPos.y, roomName: exitPos.roomName };
            range = 0;
        } else if (activeFlag) {
            moveTarget = { x: activeFlag.pos.x, y: activeFlag.pos.y, roomName: activeFlag.pos.roomName };
            range = ASSAULT_RANGE;
        }
    } else if (target) {
        if (state === 'engage' && isSoloRanged && meleeHostile && meleeRange <= DEFAULT_KITE_TRIGGER_RANGE) {
            const step = getKiteStep(creep, meleeHostile, {
                room: currentRoom,
                hostiles,
                towers,
                kiteRange: DEFAULT_KITE_RANGE,
                avoidBorders: DEFAULT_KITE_AVOID_BORDERS,
                avoidSwamp: DEFAULT_KITE_AVOID_SWAMP,
                swampBuffer: DEFAULT_SWAMP_KITE_BUFFER,
                requireNonDecreasingRange: true,
                includeStay: true
            });
            if (step) {
                moveTarget = { x: step.x, y: step.y, roomName: step.roomName || currentRoom.name };
                range = 0;
                return { moveTarget, range };
            }
        }
        const hasRanged = creep.getActiveBodyparts(RANGED_ATTACK) > 0;
        const isHarmlessStructure = !!(closeRangeStructures && target && target.structureType === STRUCTURE_WALL);
        const desiredRange = isHarmlessStructure ? 1 : (hasRanged ? 3 : 1);
        const currentRange = creep.pos.getRangeTo(target.pos);
        let step = null;
        if (currentRange > desiredRange) {
            step = getApproachStep(creep, target.pos, desiredRange, currentRoom, hostiles, towers);
        }
        if (step && meleeHostile && meleeRange <= 3 && isSwamp(currentRoom, step.x, step.y)) {
            const kiteStep = getKiteStep(creep, meleeHostile, {
                room: currentRoom,
                hostiles,
                towers,
                kiteRange: DEFAULT_KITE_RANGE,
                avoidBorders: DEFAULT_KITE_AVOID_BORDERS,
                avoidSwamp: DEFAULT_KITE_AVOID_SWAMP,
                swampBuffer: DEFAULT_SWAMP_KITE_BUFFER,
                requireNonDecreasingRange: true,
                includeStay: true
            });
            if (kiteStep) step = kiteStep;
        }
        if (step && meleeHostile) {
            const nextRangeToMelee = getRange(step, meleeHostile.pos);
            if (nextRangeToMelee <= 1) {
                const safeKite = getKiteStep(creep, meleeHostile, {
                    room: currentRoom,
                    hostiles,
                    towers,
                    kiteRange: DEFAULT_KITE_RANGE,
                    avoidBorders: DEFAULT_KITE_AVOID_BORDERS,
                    avoidSwamp: DEFAULT_KITE_AVOID_SWAMP,
                    swampBuffer: DEFAULT_SWAMP_KITE_BUFFER,
                    requireNonDecreasingRange: true,
                    includeStay: true
                });
                if (safeKite) step = safeKite;
                else step = null;
            }
        }
        if (step) {
            moveTarget = { x: step.x, y: step.y, roomName: step.roomName || currentRoom.name };
            range = 0;
        }
    } else if (activeFlag) {
        moveTarget = { x: activeFlag.pos.x, y: activeFlag.pos.y, roomName: activeFlag.pos.roomName };
        range = ASSAULT_RANGE;
    }

    return { moveTarget, range };
}

function getAssaultSquadMovePlans() {
    if (!global._assaultSquadMovePlans || global._assaultSquadMovePlans.time !== Game.time) {
        global._assaultSquadMovePlans = { time: Game.time, plans: {} };
    }
    return global._assaultSquadMovePlans.plans;
}

function updateAssaultStuckTracking(creep) {
    if (!creep || !creep.memory) return;
    const prevPos = creep.memory._assaultPrevPos;
    const prevMove = creep.memory._assaultPrevMoveTarget;
    const hadMove = !!(prevMove && prevMove.roomName);
    const isFatigued = creep.fatigue > 0;
    const isStuck = !isFatigued && prevPos && hadMove &&
        prevPos.roomName === creep.pos.roomName &&
        prevPos.x === creep.pos.x &&
        prevPos.y === creep.pos.y;
    creep.memory._assaultStuckTicks = isStuck ? (creep.memory._assaultStuckTicks || 0) + 1 : 0;
    creep.memory._assaultPrevPos = toPlainPos(creep.pos);
}

function commitAssaultTask(creep, task) {
    if (!creep || !creep.memory) return;
    creep.memory.task = task;
    const moveTarget = task && task.moveTarget ? task.moveTarget : null;
    creep.memory._assaultPrevMoveTarget = moveTarget
        ? { x: moveTarget.x, y: moveTarget.y, roomName: moveTarget.roomName }
        : null;
}

function updateDuoBreakState(leader, support, supportRange) {
    if (!leader || !support) return false;
    const leaderStuck = (leader.memory._assaultStuckTicks || 0) >= DUO_STUCK_TICKS;
    const supportStuck = (support.memory._assaultStuckTicks || 0) >= DUO_STUCK_TICKS;
    if (leaderStuck || supportStuck) {
        const until = Game.time + DUO_BREAK_TICKS;
        leader.memory._assaultBreakUntil = Math.max(leader.memory._assaultBreakUntil || 0, until);
        support.memory._assaultBreakUntil = Math.max(support.memory._assaultBreakUntil || 0, until);
    }

    const breakUntil = Math.max(leader.memory._assaultBreakUntil || 0, support.memory._assaultBreakUntil || 0);
    const shouldBreak = Game.time < breakUntil;
    if (!shouldBreak) {
        const range = getRange(leader.pos, support.pos);
        const desired = Math.max(1, Math.floor(supportRange || 1));
        if (range <= desired) {
            delete leader.memory._assaultBreakUntil;
            delete support.memory._assaultBreakUntil;
        }
    }
    return shouldBreak;
}

function updateDuoBlockedState(leader, support, isBlocked) {
    if (!leader || !support) return;
    if (isBlocked) {
        leader.memory._assaultDuoBlockedTicks = (leader.memory._assaultDuoBlockedTicks || 0) + 1;
        support.memory._assaultDuoBlockedTicks = (support.memory._assaultDuoBlockedTicks || 0) + 1;
    } else {
        leader.memory._assaultDuoBlockedTicks = 0;
        support.memory._assaultDuoBlockedTicks = 0;
    }
    const blockedTicks = Math.max(leader.memory._assaultDuoBlockedTicks || 0, support.memory._assaultDuoBlockedTicks || 0);
    if (blockedTicks >= DUO_BLOCKED_TICKS) {
        const until = Game.time + DUO_BREAK_TICKS;
        leader.memory._assaultBreakUntil = Math.max(leader.memory._assaultBreakUntil || 0, until);
        support.memory._assaultBreakUntil = Math.max(support.memory._assaultBreakUntil || 0, until);
    }
}

function getDuoMovePlan(options) {
    const {
        squadKey,
        leader,
        support,
        currentRoom,
        activeFlag,
        waitPos,
        attackFlag,
        targetRoomName,
        targetRoom,
        dangerRadius,
        assaultMode,
        supportRange,
        hostiles,
        towers,
        damageBuffer,
        retreatAt,
        reengageAt,
        safeDamageRatio,
        closeRangeStructures
    } = options || {};

    if (!squadKey || !leader || !support || !currentRoom) return null;
    if (!leader.pos || !support.pos) return null;
    if (leader.pos.roomName !== currentRoom.name || support.pos.roomName !== currentRoom.name) return null;

    if (updateDuoBreakState(leader, support, supportRange)) return null;

    const plans = getAssaultSquadMovePlans();
    const key = `${squadKey}:${currentRoom.name}`;
    if (plans[key]) return plans[key];

    const squad = getMissionSquad(leader, squadKey, currentRoom.name);
    const healPerTick = getSquadHealPerTick(leader, squad);
    const incomingDamage = getExpectedIncomingDamage(leader.pos, hostiles, towers, { rangeBuffer: 1 });
    const sustainableDamage = healPerTick + damageBuffer;
    const leaderState = resolveAssaultState(leader, incomingDamage, sustainableDamage, {
        retreatAt,
        reengageAt,
        safeDamageRatio
    });
    const leaderThreat = currentRoom ? getNearestMeleeHostile(leader.pos, hostiles) : null;
    const supportThreat = currentRoom ? getNearestMeleeHostile(support.pos, hostiles) : null;
    let meleeHostile = null;
    let meleeRangeLeader = Infinity;
    let meleeRangeSupport = Infinity;
    if (leaderThreat && (!supportThreat || leaderThreat.range <= supportThreat.range)) {
        meleeHostile = leaderThreat.hostile;
        meleeRangeLeader = leaderThreat.range;
        meleeRangeSupport = meleeHostile ? getRange(support.pos, meleeHostile.pos) : Infinity;
    } else if (supportThreat) {
        meleeHostile = supportThreat.hostile;
        meleeRangeSupport = supportThreat.range;
        meleeRangeLeader = meleeHostile ? getRange(leader.pos, meleeHostile.pos) : Infinity;
    }
    const meleeRange = Math.min(meleeRangeLeader, meleeRangeSupport);

    const target = (targetRoom && attackFlag && currentRoom && currentRoom.name === targetRoom.name)
        ? selectAssaultTarget(leader, attackFlag, hostiles, dangerRadius, { mode: assaultMode })
        : null;

    const leaderFatigued = leader.fatigue > 0;
    const supportFatigued = support.fatigue > 0;
    const desiredRange = Math.max(1, Math.floor(supportRange || 1));
    const currentRange = getRange(leader.pos, support.pos);
    const allowLeaderMove = !leaderFatigued && !supportFatigued && currentRange <= desiredRange;
    const allowSupportCatchUp = !supportFatigued && currentRange > desiredRange;

    let duoKitePlan = null;
    let duoKiteTriggered = false;
    //const allowDuoKite = allowLeaderMove && (leaderState === 'engage' || leaderState === 'heal');
    const allowDuoKite =
        !leaderFatigued &&
        !supportFatigued &&
        (leaderState === 'engage' || leaderState === 'heal');
    if (allowDuoKite && meleeHostile) {
        const triggerRange = leaderState === 'heal' ? DEFAULT_HEAL_KITE_TRIGGER_RANGE : DEFAULT_KITE_TRIGGER_RANGE;
        duoKiteTriggered = meleeRange <= triggerRange;
        if (duoKiteTriggered) {
            duoKitePlan = getDuoKiteStep(leader, support, currentRoom, hostiles, towers, supportRange, {
                meleeHostile,
                kiteRange: DEFAULT_KITE_RANGE,
                avoidBorders: DEFAULT_KITE_AVOID_BORDERS,
                avoidSwamp: DEFAULT_KITE_AVOID_SWAMP,
                swampBuffer: DEFAULT_SWAMP_KITE_BUFFER,
                requireNonDecreasingRange: true
            });
        }
    }

    const leaderIntent = (duoKitePlan) ? null : getAssaultMoveIntent(leader, {
        activeFlag,
        waitPos,
        targetRoomName,
        target,
        state: leaderState,
        isLeader: true,
        leader,
        partner: support,
        supportRange,
        currentRoom,
        hostiles,
        towers,
        incomingDamage,
        sustainableDamage,
        safeDamageRatio,
        assaultRole: leader.memory.assaultRole || 'leader',
        closeRangeStructures
    });

    let leaderStep = null;
    if (duoKitePlan && duoKitePlan.leaderStep) {
        leaderStep = duoKitePlan.leaderStep;
    } else if (allowLeaderMove &&
        leaderIntent && leaderIntent.moveTarget && leaderIntent.moveTarget.roomName === currentRoom.name) {
        const positions = [leader.pos, support.pos];
        const leaderTarget = leaderIntent.moveTarget;
        const isDirectStep = leaderIntent.range === 0 && getRange(leader.pos, leaderTarget) <= 1;
        leaderStep = isDirectStep
            ? leaderTarget
            : getApproachStepDuo(leader, leaderTarget, leaderIntent.range, currentRoom, hostiles, towers, supportRange, positions);
    }
    if (leaderStep && getRange(leader.pos, leaderStep) === 0) leaderStep = null;

    const squadIds = new Set([leader.id, support.id]);
    let leaderNext = leader.pos;
    let supportNext = support.pos;

    let blocked = false;
    let usedKite = !!(duoKitePlan && duoKitePlan.leaderStep && duoKitePlan.supportStep);
    let presetSupportStep = usedKite ? duoKitePlan.supportStep : null;

    if (!usedKite &&
        leaderStep &&
        allowLeaderMove &&
        (leaderState === 'engage' || leaderState === 'heal') &&
        meleeHostile &&
        meleeRange <= 3 &&
        isSwamp(currentRoom, leaderStep.x, leaderStep.y)) {
        const swampKitePlan = getDuoKiteStep(leader, support, currentRoom, hostiles, towers, supportRange, {
            meleeHostile,
            kiteRange: DEFAULT_KITE_RANGE,
            avoidBorders: DEFAULT_KITE_AVOID_BORDERS,
            avoidSwamp: DEFAULT_KITE_AVOID_SWAMP,
            swampBuffer: DEFAULT_SWAMP_KITE_BUFFER,
            requireNonDecreasingRange: true
        });
        if (swampKitePlan && swampKitePlan.leaderStep && swampKitePlan.supportStep) {
            leaderStep = swampKitePlan.leaderStep;
            presetSupportStep = swampKitePlan.supportStep;
            usedKite = true;
        }
    }

    if (leaderStep) {
        const supportStep = usedKite
            ? presetSupportStep
            : getSupportStepForLeaderMove(leaderStep, leader.pos, support.pos, currentRoom, supportRange, squadIds);
        if (supportStep) {
            leaderNext = leaderStep;
            supportNext = supportStep;
        } else {
            blocked = true;
            leaderNext = leader.pos;
            supportNext = support.pos;
            logAssault(leader, null, 'hard clamp triggered: missing supportStep, cancel move', {
                leaderId: leader.id,
                supportId: support.id
            });
        }
    } else {
        if (allowSupportCatchUp && !duoKiteTriggered) {
            const catchStep = getSupportCatchUpStep(support, leader.pos, supportRange, currentRoom, hostiles, towers, { ignoreDanger: true });
            supportNext = catchStep || support.pos;
        } else {
            supportNext = support.pos;
        }
    }

    if (leaderNext && supportNext &&
        !samePos(leaderNext, leader.pos) &&
        !samePos(supportNext, support.pos)) {
        const fatigueSync = predictDuoFatigueSync(
            leader,
            support,
            currentRoom,
            leader.pos,
            leaderNext,
            support.pos,
            supportNext
        );
        if (!fatigueSync.syncOk && leaderState !== 'retreat') {
            blocked = true;
            leaderNext = leader.pos;
            supportNext = support.pos;
        }
    }
    updateDuoBlockedState(leader, support, blocked);

    const moveOpts = { ignoreCreeps: true };
    const moves = {};
    moves[leader.id] = {
        moveTarget: leaderNext && !samePos(leaderNext, leader.pos) ? toPlainPos(leaderNext) : null,
        range: 0,
        moveOpts
    };
    moves[support.id] = {
        moveTarget: supportNext && !samePos(supportNext, support.pos) ? toPlainPos(supportNext) : null,
        range: 0,
        moveOpts
    };

    const plan = { leaderId: leader.id, supportId: support.id, moves };
    plans[key] = plan;
    return plan;
}

function executeAssault(creep, mission) {
    const data = mission.data || {};
    const waitFlagName = data.waitFlagName || 'W';
    const waypointFlagName = data.waypointFlagName || waitFlagName;
    const attackFlagName = data.attackFlagName || 'A';
    const assaultMode = data.assaultMode || 'attack';
    const waitFlag = Game.flags[waitFlagName];
    const attackFlag = Game.flags[attackFlagName];
    const primaryFlag = attackFlag || waitFlag;

    if (!primaryFlag) {
        delete creep.memory.task;
        if (creep.memory) creep.memory._assaultPrevMoveTarget = null;
        return;
    }

    const attackRoomName = attackFlag ? attackFlag.pos.roomName : (waitFlag ? waitFlag.pos.roomName : null);
    const currentRoom = creep.room;
    const targetRoom = attackRoomName ? Game.rooms[attackRoomName] : null;
    const actions = [];
    let plannedMove = null;

    updateAssaultStuckTracking(creep);

    const hostiles = currentRoom ? getHostiles(currentRoom) : [];
    const towers = currentRoom ? getHostileTowers(currentRoom) : [];
    const assaultRole = data.assaultRole || creep.memory.assaultRole || 'leader';
    const squadKey = data.squadKey || creep.memory.assaultSquad || creep.memory.missionName;
    if (squadKey) creep.memory.assaultSquad = squadKey;
    creep.memory.assaultRole = assaultRole;

    const prevState = creep.memory.assaultState;
    const squad = getMissionSquad(creep, squadKey, currentRoom ? currentRoom.name : null);
    const fullSquad = getMissionSquadAll(squadKey);
    const squadLock = isAssaultSquadLocked(squadKey, fullSquad.length);
    const leader = getAssaultLeader(fullSquad.length > 0 ? fullSquad : squad);
    const partner = getSquadPartner(creep, fullSquad.length > 0 ? fullSquad : squad);
    const support = leader ? (leader.id === creep.id ? partner : creep) : null;
    const isLeader = assaultRole !== 'support' || !leader || leader.id === creep.id;
    const expectedSquadSize = assaultRole === 'solo' ? 1 : 2;
    const squadCount = (fullSquad.length > 0 ? fullSquad.length : squad.length);
    const healPerTick = getSquadHealPerTick(creep, squad);
    const assaultMemory = Memory && Memory.military && Memory.military.attack ? Memory.military.attack : null;
    const resolveAssaultParam = (key, fallback) => {
        const memValue = assaultMemory && Object.prototype.hasOwnProperty.call(assaultMemory, key)
            ? assaultMemory[key]
            : undefined;
        if (Number.isFinite(memValue)) return memValue;
        const dataValue = data && Object.prototype.hasOwnProperty.call(data, key)
            ? data[key]
            : undefined;
        if (Number.isFinite(dataValue)) return dataValue;
        return fallback;
    };

    const damageBuffer = resolveAssaultParam('damageBuffer', DEFAULT_DAMAGE_BUFFER);
    const retreatAt = resolveAssaultParam('retreatAt', DEFAULT_RETREAT_AT);
    const reengageAt = resolveAssaultParam('reengageAt', DEFAULT_REENGAGE_AT);
    const dangerRadius = resolveAssaultParam('dangerRadius', DEFAULT_DANGER_RADIUS);
    const safeDamageRatio = resolveAssaultParam('safeDamageRatio', DEFAULT_SAFE_DAMAGE_RATIO);
    const supportRange = resolveAssaultParam('supportRange', DEFAULT_SUPPORT_RANGE);
    const incomingDamage = currentRoom ? getExpectedIncomingDamage(creep.pos, hostiles, towers, { rangeBuffer: 1 }) : 0;
    const sustainableDamage = healPerTick + damageBuffer;

    if (assaultRole !== 'solo' && leader && partner && currentRoom && !isLeader) {
        const plans = getAssaultSquadMovePlans();
        const key = `${squadKey}:${currentRoom.name}`;
        const plan = plans[key];

        if (plan && plan.moves && plan.moves[creep.id]) {
            plannedMove = plan.moves[creep.id];
        }

        // ✅ No plan yet (likely support executed before leader this tick).
        // Fall through to normal moveIntent so support follows leader instead of freezing.
    }

    const isInAttackRoom = currentRoom && attackRoomName && currentRoom.name === attackRoomName;
    const lastRoom = creep.memory._assaultLastRoom;
    if (currentRoom && currentRoom.name !== lastRoom) {
        creep.memory._assaultEnteredAt = Game.time;
        creep.memory._assaultLastRoom = currentRoom.name;
    }
    const enteredAt = creep.memory._assaultEnteredAt;
    const justEntered = Number.isFinite(enteredAt) && Game.time - enteredAt <= 2;

    let state = resolveAssaultState(creep, incomingDamage, sustainableDamage, {
        retreatAt,
        reengageAt,
        safeDamageRatio
    });
    if (isInAttackRoom && justEntered && isBorderPos(creep.pos) && state === 'retreat') {
        state = 'engage';
    }

    if (!isLeader && leader && leader.memory) {
        const leaderState = leader.memory.assaultState;
        if (leaderState === 'retreat') state = 'retreat';
        else if (leaderState === 'heal' && state === 'engage') state = 'heal';
    }
    creep.memory.assaultState = state;

    const partnerRoom = partner && partner.pos ? partner.pos.roomName : null;
    const leaderRoom = leader && leader.pos ? leader.pos.roomName : null;
    const needsCohesion = assaultRole !== 'solo' && currentRoom && partnerRoom && partnerRoom !== currentRoom.name;
    const waypoints = getAssaultWaypointFlags(waypointFlagName);
    const waypointSignature = getAssaultWaypointSignature(waypoints);
    const waypointOwner = leader || creep;
    const waypointIndex = waypointOwner && waypointOwner.memory && Number.isFinite(waypointOwner.memory._assaultWaypointIndex)
        ? waypointOwner.memory._assaultWaypointIndex
        : 0;
    const waypointSigMatches = waypointOwner && waypointOwner.memory
        && waypointOwner.memory._assaultWaypointSig === waypointSignature;
    const waypointsCompleted = waypointSigMatches && waypointIndex >= waypoints.length;
    const shouldResumeLatestWaypoint = state === 'engage'
        && (prevState === 'retreat' || prevState === 'heal')
        && waypoints.length > 0
        && waypointsCompleted
        && currentRoom && attackRoomName && currentRoom.name !== attackRoomName;
    if (shouldResumeLatestWaypoint && waypointOwner && waypointOwner.memory) {
        waypointOwner.memory._assaultWaypointIndex = Math.max(0, waypoints.length - 1);
        waypointOwner.memory._assaultWaypointSig = waypointSignature;
    }
    const allowWaypointAdvance = state !== 'retreat' && (assaultRole === 'solo' || squadCount >= expectedSquadSize || squadLock);
    const waypointState = resolveAssaultWaypointState(creep, leader, support, waypoints, supportRange, allowWaypointAdvance);
    const waypointFlag = waypointState && waypointState.waypoint ? waypointState.waypoint.flag : null;
    const routeFlag = waypointFlag || attackFlag || waitFlag;
    const routeRoomName = routeFlag && routeFlag.pos ? routeFlag.pos.roomName : null;

    if (waypointOwner && waypointOwner.memory) {
        const prevIndex = Number.isFinite(waypointIndex) ? waypointIndex : 0;
        const nextIndex = waypointState ? waypointState.index : prevIndex;
        const advanced = nextIndex > prevIndex;
        const waypointDebug = {
            baseName: waypointFlagName,
            signature: waypointSignature,
            index: nextIndex,
            completed: !!(waypointState && waypointState.completed),
            allowAdvance: allowWaypointAdvance,
            count: waypoints.length,
            selectedFlagName: waypointFlag ? waypointFlag.name : null,
            selectedPos: waypointFlag && waypointFlag.pos ? toPlainPos(waypointFlag.pos) : null,
            routeFlagName: routeFlag ? routeFlag.name : null,
            routeRoomName,
            shouldResumeLatestWaypoint,
            lastAdvanceAt: advanced ? Game.time : (waypointOwner.memory.assaultWaypoint && waypointOwner.memory.assaultWaypoint.lastAdvanceAt) || null,
            updatedAt: Game.time
        };
        waypointOwner.memory.assaultWaypoint = waypointDebug;
        if (leader && leader.id !== waypointOwner.id && leader.memory) {
            leader.memory.assaultWaypoint = waypointDebug;
        }
        if (support && support.memory) {
            support.memory.assaultWaypoint = waypointDebug;
        }
        if (creep && creep.memory && creep.id !== waypointOwner.id) {
            creep.memory.assaultWaypoint = waypointDebug;
        }
    }

    logAssault(creep, data, 'state', {
        state,
        role: assaultRole,
        isLeader,
        currentRoom: currentRoom && currentRoom.name,
        partnerRoom,
        leaderRoom,
        attackRoomName,
        routeRoomName,
        waypointIndex: waypointState ? waypointState.index : null,
        hits: creep.hits,
        hitsMax: creep.hitsMax,
        incomingDamage,
        sustainableDamage,
        needsCohesion
    });

    const waitPos = waitFlag
        ? { x: waitFlag.pos.x, y: waitFlag.pos.y, roomName: waitFlag.pos.roomName }
        : (data.waitPos && Number.isFinite(data.waitPos.x) && Number.isFinite(data.waitPos.y)
            ? { x: data.waitPos.x, y: data.waitPos.y, roomName: data.waitPos.roomName }
            : null);
    const duoAssembled = isDuoAssembled(fullSquad.length > 0 ? fullSquad : squad, leader, waitPos, supportRange);
    const hasAssembled = squadLock || !!creep.memory.assaultAssembled || duoAssembled;

    if (assaultRole !== 'solo' && waitPos && !hasAssembled && state !== 'retreat') {
        if (currentRoom && currentRoom.name !== waitPos.roomName) {
            const exitPos = getExitPosToward(creep, waitPos.roomName, waitPos);
            console.log(`[assault:${Game.time}] pre-assembly`, JSON.stringify({
                creep: creep.name,
                role: assaultRole,
                fromRoom: currentRoom && currentRoom.name,
                waitPos,
                exitPos: exitPos ? toPlainPos(exitPos) : null,
                hasAssembled,
                state
            }));
            if (exitPos) {
                commitAssaultTask(creep, {
                    actions,
                    moveTarget: { x: exitPos.x, y: exitPos.y, roomName: exitPos.roomName },
                    range: 0
                });
                return;
            }
        }
        // Pre-assembly pairing step (support only) once inside the wait room.
        if (currentRoom && currentRoom.name === waitPos.roomName && leader && partner && leader.pos && partner.pos) {
            const iAmSupport = !isLeader;
            if (iAmSupport && leader.pos.roomName === currentRoom.name) {
                const desired = Math.max(1, Math.floor(supportRange || 1));
                if (getRange(creep.pos, leader.pos) > desired) {
                    commitAssaultTask(creep, {
                        actions,
                        moveTarget: { x: leader.pos.x, y: leader.pos.y, roomName: leader.pos.roomName },
                        range: desired
                    });
                    return;
                }
            }
        }
        console.log(`[assault:${Game.time}] pre-assembly`, JSON.stringify({
            creep: creep.name,
            role: assaultRole,
            fromRoom: currentRoom && currentRoom.name,
            waitPos,
            exitPos: null,
            hasAssembled,
            state
        }));
        commitAssaultTask(creep, {
            actions,
            moveTarget: { x: waitPos.x, y: waitPos.y, roomName: waitPos.roomName },
            range: 1
        });
        return;
    }
    if (assaultRole !== 'solo' && waitPos && squadCount < expectedSquadSize && !squadLock) {
        delete creep.memory.assaultAssembled;
        logAssault(creep, data, 'regroup', {
            squadCount,
            expectedSquadSize,
            waitPos,
            currentRoom: currentRoom && currentRoom.name
        });
        commitAssaultTask(creep, {
            actions,
            moveTarget: { x: waitPos.x, y: waitPos.y, roomName: waitPos.roomName },
            range: 1
        });
        return;
    }
    if (assaultRole !== 'solo' && duoAssembled && leader && support) {
        markAssaultSquadStarted(squadKey, leader, support);
    }
    if (assaultRole !== 'solo') {
        if (squadCount < expectedSquadSize) {
            if (!squadLock) delete creep.memory.assaultAssembled;
        } else if (duoAssembled) {
            creep.memory.assaultAssembled = true;
        }
    }
    const target = (targetRoom && attackFlag && currentRoom && currentRoom.name === targetRoom.name)
        ? selectAssaultTarget(creep, attackFlag, hostiles, dangerRadius, { mode: assaultMode })
        : null;

    logAssault(creep, data, 'attackTarget', {
        targetId: target && target.id,
        targetType: target && target.structureType ? 'structure' : (target ? 'creep' : null),
        structureType: target && target.structureType,
        targetPos: target && target.pos ? toPlainPos(target.pos) : null
    });

    if (target && state !== 'retreat') {
        const range = creep.pos.getRangeTo(target);
        if (assaultMode === 'dismantle') {
            if (creep.getActiveBodyparts(WORK) > 0 && range <= 1) {
                actions.push({ action: 'dismantle', targetId: target.id });
            }
        } else {
            if (creep.getActiveBodyparts(RANGED_ATTACK) > 0 && range <= 3) {
                if (assaultMode === 'rangedMass' && target.structureType) {
                    actions.push({ action: 'rangedMassAttack' });
                } else {
                    actions.push({ action: 'rangedAttack', targetId: target.id });
                }
            }
            if (creep.getActiveBodyparts(ATTACK) > 0 && range <= 1) {
                actions.push({ action: 'attack', targetId: target.id });
            }
        }
    }

    const healTarget = selectHealTarget(creep, squad);
    if (healTarget) {
        const healRange = getRange(creep.pos, healTarget.pos);
        if (healRange <= 1 || healTarget.id === creep.id) {
            actions.push({ action: 'heal', targetId: healTarget.id });
        } else if (healRange <= 3) {
            actions.push({ action: 'rangedHeal', targetId: healTarget.id });
        }
    }

    const ignoreCohesion = !!(squadLock && assaultRole !== 'solo' && squadCount < expectedSquadSize);
    const moveIntent = getAssaultMoveIntent(creep, {
        activeFlag: routeFlag,
        waitPos,
        targetRoomName: routeRoomName,
        target,
        state,
        isLeader,
        leader,
        partner,
        supportRange,
        currentRoom,
        hostiles,
        towers,
        incomingDamage,
        sustainableDamage,
        safeDamageRatio,
        assaultRole,
        assaultMode,
        closeRangeStructures: data.closeRangeStructures,
        ignoreCohesion
    });

    let moveTarget = moveIntent.moveTarget;
    let range = moveIntent.range;
    let moveOpts = null;

    logAssault(creep, data, 'intent', {
        moveTarget,
        range,
        needsCohesion,
        currentRoom: currentRoom && currentRoom.name,
        partnerRoom,
        leaderRoom,
        routeRoomName,
        state,
        role: assaultRole,
        isLeader
    });

    if (assaultRole !== 'solo' && squadCount === 2 && leader && support && currentRoom && isLeader) {
        const duoPlan = getDuoMovePlan({
            squadKey,
            leader,
            support,
            currentRoom,
            activeFlag: routeFlag,
            waitPos,
            attackFlag,
            targetRoomName: routeRoomName,
            targetRoom,
            dangerRadius,
            assaultMode,
            supportRange,
            hostiles,
            towers,
            damageBuffer,
            retreatAt,
            reengageAt,
            safeDamageRatio,
            closeRangeStructures: data.closeRangeStructures
        });
        if (duoPlan && duoPlan.moves && duoPlan.moves[leader.id] && duoPlan.moves[support.id]) {
            commitAssaultTask(leader, duoPlan.moves[leader.id]);
            commitAssaultTask(support, duoPlan.moves[support.id]);
            logAssault(creep, data, 'leader generated duo plan and committed for both', {
                leaderId: duoPlan.leaderId,
                supportId: duoPlan.supportId
            });
            if (duoPlan.moves[creep.id]) {
                moveTarget = duoPlan.moves[creep.id].moveTarget;
                range = duoPlan.moves[creep.id].range;
                moveOpts = duoPlan.moves[creep.id].moveOpts;
            }
        }
    }

    if (plannedMove) {
        if (plannedMove.moveTarget) moveTarget = plannedMove.moveTarget;
        if (plannedMove.range !== undefined && plannedMove.range !== null) range = plannedMove.range;
        if (plannedMove.moveOpts) moveOpts = plannedMove.moveOpts;
    }

    const task = {
        actions,
        moveTarget,
        range
    };
    if (moveOpts) task.moveOpts = moveOpts;
    logAssault(creep, data, 'task', {
        moveTarget,
        range,
        actions: actions.map(a => a.action)
    });
    commitAssaultTask(creep, task);
}

module.exports = {
    executeAssault,
    getExpectedIncomingDamage,
    getHostileCreepDamageAtPos,
    getHostileMeleeDamageAtPos,
    getHostileRangedDamageAtPos,
    getHostiles,
    getHostileTowers,
    getTowerDamageAtPos,
    getTowerDamageAtRange
};
