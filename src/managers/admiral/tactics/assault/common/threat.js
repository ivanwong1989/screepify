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

function evaluateThreat(leader, support, opts) {
    opts = opts || {};
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
            meleeDpsIn3: 0,
            rangedDpsIn3: 0,
            totalDpsIn3: 0,
            meleeDpsAll: 0,
            rangedDpsAll: 0,
            totalDpsAll: 0
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
            meleeDpsIn3: 0,
            rangedDpsIn3: 0,
            totalDpsIn3: 0,
            meleeDpsAll: 0,
            rangedDpsAll: 0,
            totalDpsAll: 0
        };
    }

    const meleeRange = Number.isFinite(opts.meleeRange) ? opts.meleeRange : 1;
    const rangedRange = Number.isFinite(opts.rangedRange) ? opts.rangedRange : 3;

    let closestHostileRange = Infinity;
    let nearMelee = false;
    let nearRanged = false;
    let maxIncomingPotential = 0;

    // totals (all hostiles in room)
    let meleeDpsAll = 0;
    let rangedDpsAll = 0;

    // totals (only those that can hit within relevant ranges)
    let meleeDpsIn3 = 0;
    let rangedDpsIn3 = 0;

    for (const hostile of hostiles) {
        const meleeParts = getBodyPartsCount(hostile, ATTACK);
        const rangedParts = getBodyPartsCount(hostile, RANGED_ATTACK);

        // raw unboosted DPS
        const meleeDps = meleeParts * 30;
        const rangedDps = rangedParts * 10;

        meleeDpsAll += meleeDps;
        rangedDpsAll += rangedDps;

        maxIncomingPotential = Math.max(maxIncomingPotential, meleeParts + rangedParts);

        // distance to our duo (min of leader/support if same room)
        let range = Infinity;
        if (leader && leader.room && leader.room.name === hostile.room.name) {
            range = Math.min(range, leader.pos.getRangeTo(hostile.pos));
        }
        if (support && support.room && support.room.name === hostile.room.name) {
            range = Math.min(range, support.pos.getRangeTo(hostile.pos));
        }
        closestHostileRange = Math.min(closestHostileRange, range);

        if (meleeParts > 0 && range <= meleeRange) {
            nearMelee = true;
            meleeDpsIn3 += meleeDps;
        }
        if (rangedParts > 0 && range <= rangedRange) {
            nearRanged = true;
            rangedDpsIn3 += rangedDps;
        }
    }

    const totalDpsAll = meleeDpsAll + rangedDpsAll;
    const totalDpsIn3 = meleeDpsIn3 + rangedDpsIn3;

    // threat "level" based on *relevant* (in-range) threat, not whole room.
    let score = 0;
    if (nearMelee || nearRanged) score += 2;
    if ((meleeDpsIn3 + rangedDpsIn3) >= 200) score += 1;     // tunable
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

        // NEW (what you asked for)
        meleeDpsIn3,
        rangedDpsIn3,
        totalDpsIn3,

        // NEW (optional: keep full-room signal too)
        meleeDpsAll,
        rangedDpsAll,
        totalDpsAll
    };
}

module.exports = {
    evaluateThreat,
    getHostilesInRoom,
    filterOutAllies,
    isAllyOwner
};
