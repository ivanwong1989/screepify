function getHostilesInRoom(room) {
    if (!room) return [];
    return room.find(FIND_HOSTILE_CREEPS) || [];
}

function getBodyPartsCount(creep, type) {
    if (!creep || !creep.body) return 0;
    let count = 0;
    for (const part of creep.body) {
        if (part.type === type && part.hits > 0) count += 1;
    }
    return count;
}

function evaluateThreat(leader, support) {
    const anchor = leader || support;
    if (!anchor || !anchor.room) {
        return {
            level: 0,
            nearMelee: false,
            nearRanged: false,
            maxIncomingPotential: 0,
            closestHostileRange: Infinity,
            hostiles: 0
        };
    }

    const rooms = [];
    if (leader && leader.room) rooms.push(leader.room);
    if (support && support.room && (!leader || support.room.name !== leader.room.name)) rooms.push(support.room);

    const hostileMap = new Map();
    for (const room of rooms) {
        const hostiles = getHostilesInRoom(room);
        for (const hostile of hostiles) {
            hostileMap.set(hostile.id, hostile);
        }
    }

    const hostiles = Array.from(hostileMap.values());
    if (hostiles.length === 0) {
        return {
            level: 0,
            nearMelee: false,
            nearRanged: false,
            maxIncomingPotential: 0,
            closestHostileRange: Infinity,
            hostiles: 0
        };
    }

    let closestHostileRange = Infinity;
    let nearMelee = false;
    let nearRanged = false;
    let maxIncomingPotential = 0;
    let totalMelee = 0;
    let totalRanged = 0;

    for (const hostile of hostiles) {
        const meleeParts = getBodyPartsCount(hostile, ATTACK);
        const rangedParts = getBodyPartsCount(hostile, RANGED_ATTACK);
        totalMelee += meleeParts;
        totalRanged += rangedParts;
        maxIncomingPotential = Math.max(maxIncomingPotential, meleeParts + rangedParts);

        let range = Infinity;
        if (leader && leader.room && leader.room.name === hostile.room.name) {
            range = Math.min(range, leader.pos.getRangeTo(hostile.pos));
        }
        if (support && support.room && support.room.name === hostile.room.name) {
            range = Math.min(range, support.pos.getRangeTo(hostile.pos));
        }
        closestHostileRange = Math.min(closestHostileRange, range);

        if (meleeParts > 0 && range <= 1) nearMelee = true;
        if (rangedParts > 0 && range <= 3) nearRanged = true;
    }

    let score = 0;
    if (nearMelee || nearRanged) score += 2;
    if (totalMelee + totalRanged >= 10) score += 1;
    if (hostiles.length >= 3) score += 1;
    if (closestHostileRange <= 2) score += 1;

    let level = 1;
    if (score >= 4) level = 3;
    else if (score >= 2) level = 2;

    return {
        level,
        nearMelee,
        nearRanged,
        maxIncomingPotential,
        closestHostileRange,
        hostiles: hostiles.length
    };
}

module.exports = {
    evaluateThreat
};
