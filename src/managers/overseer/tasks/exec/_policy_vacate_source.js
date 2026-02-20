const DEFAULT_ALLOW_ROLES = [
    'miner',
    'staticMiner',
    'remoteHarvester',
    'remote_miner',
    'harvester_remote'
];

const DEFAULT_ALLOWED_INFRA = [STRUCTURE_CONTAINER, STRUCTURE_ROAD, STRUCTURE_LINK];

function getSources(room) {
    if (!room) return [];
    return room.find(FIND_SOURCES) || [];
}

function isNearSource(pos, sources, forbidRange) {
    if (!pos || !sources || sources.length === 0) return false;
    const range = Math.max(1, Math.floor(forbidRange || 1));
    for (const source of sources) {
        if (pos.getRangeTo(source.pos) <= range) return true;
    }
    return false;
}

function isSourceInfra(structureType, allowedTypes) {
    if (!structureType) return false;
    if (!Array.isArray(allowedTypes) || allowedTypes.length === 0) return false;
    return allowedTypes.includes(structureType);
}

function isTargetNearSource(targetPos, sources, forbidRange) {
    if (!targetPos || !sources || sources.length === 0) return false;
    const range = Math.max(1, Math.floor(forbidRange || 1));
    for (const source of sources) {
        if (targetPos.getRangeTo(source.pos) <= range) return true;
    }
    return false;
}

function isPassableStructure(structure) {
    if (!structure) return true;
    if (structure.structureType === STRUCTURE_ROAD) return true;
    if (structure.structureType === STRUCTURE_CONTAINER) return true;
    if (structure.structureType === STRUCTURE_RAMPART && (structure.my || structure.isPublic)) return true;
    return false;
}

function isWalkablePos(room, x, y) {
    if (!room) return false;
    if (x < 0 || x > 49 || y < 0 || y > 49) return false;
    const terrain = room.getTerrain().get(x, y);
    if (terrain === TERRAIN_MASK_WALL) return false;
    const structures = room.lookForAt(LOOK_STRUCTURES, x, y);
    for (const structure of structures) {
        if (!isPassableStructure(structure)) return false;
    }
    return true;
}

function isOccupied(room, x, y, creepId) {
    if (!room) return false;
    const creeps = room.lookForAt(LOOK_CREEPS, x, y);
    if (!creeps || creeps.length === 0) return false;
    if (!creepId) return true;
    if (creeps.length === 1 && creeps[0].id === creepId) return false;
    return true;
}

function getCandidatePositionsAroundTarget(room, targetPos, workRange) {
    const candidates = [];
    if (!room || !targetPos) return candidates;
    const range = Math.max(1, Math.floor(workRange || 1));
    for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) {
            const x = targetPos.x + dx;
            const y = targetPos.y + dy;
            if (x < 0 || x > 49 || y < 0 || y > 49) continue;
            if (Math.max(Math.abs(dx), Math.abs(dy)) > range) continue;
            candidates.push({ x, y, roomName: targetPos.roomName || room.name });
        }
    }
    return candidates;
}

function pickClosest(creepPos, candidates) {
    if (!creepPos || !candidates || candidates.length === 0) return null;
    let best = null;
    let bestRange = Infinity;
    for (const candidate of candidates) {
        const range = creepPos.getRangeTo(candidate.x, candidate.y);
        if (range < bestRange) {
            bestRange = range;
            best = candidate;
        }
    }
    return best;
}

function buildMoveIntent(pos, reason) {
    if (!pos) return null;
    return {
        type: 'move',
        action: 'move',
        targetPos: { x: pos.x, y: pos.y, roomName: pos.roomName },
        range: 0,
        _policy: 'vacate_source',
        _reason: reason || 'near_source'
    };
}

function getVacateSourceMoveIntent(creep, workKind, workTarget, workRange, opts = {}) {
    if (!creep || !creep.pos || !creep.room) return null;
    if (!workTarget || !workTarget.pos) return null;

    const sources = getSources(creep.room);
    if (!sources || sources.length === 0) return null;

    const forbidRangeFromSource = Number.isFinite(opts.forbidRangeFromSource)
        ? opts.forbidRangeFromSource
        : 1;

    if (!isNearSource(creep.pos, sources, forbidRangeFromSource)) return null;

    if (workKind === 'repair') {
        const allowedRoles = Array.isArray(opts.allowRolesNearSource)
            ? opts.allowRolesNearSource
            : DEFAULT_ALLOW_ROLES;
        const role = (creep.memory && (creep.memory.role || creep.memory.job || creep.memory.type || creep.memory.designation)) || '';
        const allowedTypes = Array.isArray(opts.allowedSourceInfraTypes)
            ? opts.allowedSourceInfraTypes
            : DEFAULT_ALLOWED_INFRA;
        const requireTargetNearSource = opts.requireTargetNearSource !== false;

        if (allowedRoles.includes(role) &&
            isSourceInfra(workTarget.structureType, allowedTypes) &&
            (!requireTargetNearSource || isTargetNearSource(workTarget.pos, sources, forbidRangeFromSource))) {
            return null;
        }
    }

    const useOccupancyCheck = opts.useOccupancyCheck !== false;
    const candidates = getCandidatePositionsAroundTarget(creep.room, workTarget.pos, workRange);
    const valid = [];

    for (const candidate of candidates) {
        if (!isWalkablePos(creep.room, candidate.x, candidate.y)) continue;
        if (isNearSource(new RoomPosition(candidate.x, candidate.y, candidate.roomName), sources, forbidRangeFromSource)) continue;
        if (useOccupancyCheck && isOccupied(creep.room, candidate.x, candidate.y, creep.id)) continue;
        valid.push(candidate);
    }

    const best = pickClosest(creep.pos, valid);
    if (best) return buildMoveIntent(best, 'near_source');

    const nearestSource = creep.pos.findClosestByRange(sources);
    if (nearestSource) {
        const currentRange = creep.pos.getRangeTo(nearestSource.pos);
        let fallback = null;
        let bestRange = currentRange;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                const x = creep.pos.x + dx;
                const y = creep.pos.y + dy;
                if (!isWalkablePos(creep.room, x, y)) continue;
                if (useOccupancyCheck && isOccupied(creep.room, x, y, creep.id)) continue;
                const range = new RoomPosition(x, y, creep.pos.roomName).getRangeTo(nearestSource.pos);
                if (range > bestRange) {
                    bestRange = range;
                    fallback = { x, y, roomName: creep.pos.roomName };
                }
            }
        }
        if (fallback) return buildMoveIntent(fallback, 'near_source');
    }

    return null;
}

module.exports = {
    getVacateSourceMoveIntent
};
