function getAlliesLower() {
    if (!Array.isArray(Memory.allies)) Memory.allies = [];
    return Memory.allies.map(a => ('' + a).toLowerCase());
}

function isAllyOwner(owner, alliesLower) {
    if (!owner || !owner.username) return false;
    const list = alliesLower || getAlliesLower();
    return list.includes(('' + owner.username).toLowerCase());
}

function filterOutAllies(objs) {
    if (!objs || !objs.length) return [];
    const alliesLower = getAlliesLower();
    return objs.filter(o => !isAllyOwner(o && o.owner, alliesLower));
}

function getHostilesInRoom(room) {
    if (!room) return [];

    // Prefer the central cache if available (it already filters allies)
    try {
        if (global.getRoomCache) {
            const cache = global.getRoomCache(room);
            if (cache && Array.isArray(cache.hostiles)) return cache.hostiles;
        }
    } catch (e) {
        // fall back to raw find
    }

    // Fallback: raw hostiles, but filter allies out
    const raw = room.find(FIND_HOSTILE_CREEPS) || [];
    return filterOutAllies(raw);
}

function computeHostileDps(hostiles) {
    let meleeDps = 0;
    let rangedDps = 0;

    for (const h of hostiles) {
        meleeDps += getBodyPartsCount(h, ATTACK) * 30;
        rangedDps += getBodyPartsCount(h, RANGED_ATTACK) * 10;
    }

    return {
        meleeDps,
        rangedDps,
        totalDps: meleeDps + rangedDps
    };
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
            hostiles: 0,
            // NEW
            meleeParts: 0,
            rangedParts: 0,
            meleeDps: 0,
            rangedDps: 0,
            totalDps: 0
        };
    }

    const rooms = [];
    if (leader && leader.room) rooms.push(leader.room);
    if (support && support.room && (!leader || support.room.name !== leader.room.name)) rooms.push(support.room);

    const hostileMap = new Map();
    for (const room of rooms) {
        const hostiles = getHostilesInRoom(room);
        for (const hostile of hostiles) hostileMap.set(hostile.id, hostile);
    }

    const hostiles = Array.from(hostileMap.values());
    if (hostiles.length === 0) {
        return {
            level: 0,
            nearMelee: false,
            nearRanged: false,
            maxIncomingPotential: 0,
            closestHostileRange: Infinity,
            hostiles: 0,
            // NEW
            meleeParts: 0,
            rangedParts: 0,
            meleeDps: 0,
            rangedDps: 0,
            totalDps: 0
        };
    }

    let closestHostileRange = Infinity;
    let nearMelee = false;
    let nearRanged = false;
    let maxIncomingPotential = 0;

    // NEW totals
    let totalMeleeParts = 0;
    let totalRangedParts = 0;
    let totalMeleeDps = 0;
    let totalRangedDps = 0;

    for (const hostile of hostiles) {
        const meleeParts = getBodyPartsCount(hostile, ATTACK);
        const rangedParts = getBodyPartsCount(hostile, RANGED_ATTACK);

        totalMeleeParts += meleeParts;
        totalRangedParts += rangedParts;

        // Screeps raw (unboosted) DPS per part:
        // ATTACK = 30, RANGED_ATTACK = 10
        totalMeleeDps += meleeParts * 30;
        totalRangedDps += rangedParts * 10;

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

    const totalDps = totalMeleeDps + totalRangedDps;

    let score = 0;
    if (nearMelee || nearRanged) score += 2;
    if (totalMeleeParts + totalRangedParts >= 10) score += 1;
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
        hostiles: hostiles.length,

        // NEW: richer output for “can we outheal then push to r=2?”
        meleeParts: totalMeleeParts,
        rangedParts: totalRangedParts,
        meleeDps: totalMeleeDps,
        rangedDps: totalRangedDps,
        totalDps
    };
}

module.exports = {
    evaluateThreat,
    getHostilesInRoom,
    filterOutAllies,
    isAllyOwner
};
