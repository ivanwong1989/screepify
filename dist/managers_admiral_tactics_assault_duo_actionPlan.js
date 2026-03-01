function getActiveHealParts(c) {
    return c ? c.getActiveBodyparts(HEAL) : 0;
}

function getHealRange(a, b) {
    if (!a || !b) return Infinity;
    return a.pos.getRangeTo(b);
}

// Cheap-ish threat signal: only checks melee adjacency
function hasAdjacentHostile(c) {
    if (!c || !c.room) return false;
    // small radius, low CPU
    const near = c.pos.findInRange(FIND_HOSTILE_CREEPS, 1);
    return near && near.length > 0;
}

function healUrgencyScore(target, healer) {
    if (!target || target.hits >= target.hitsMax) return -Infinity;

    const missing = target.hitsMax - target.hits;
    const missingPct = missing / target.hitsMax;

    let score = missingPct;

    // “don’t die” thresholds
    const hpPct = target.hits / target.hitsMax;
    if (hpPct < 0.35) score += 2.0;      // critical
    else if (hpPct < 0.60) score += 0.7; // pressured

    // If target can't heal well, prioritize stabilizing it
    const targetHealParts = getActiveHealParts(target);
    if (targetHealParts === 0) score += 0.25;
    else if (targetHealParts <= 5) score += 0.1;

    // If target is in melee contact, it’s more likely to spike down
    if (hasAdjacentHostile(target)) score += 0.4;

    // Slightly prefer healing the one with *less* current HP in absolute terms
    // (helps in equal % cases)
    score += (missing / 10000);

    return score;
}

function chooseBestHealTarget(healer, primaryBuddy, extraCandidates) {
    if (!healer || getActiveHealParts(healer) <= 0) return null;

    const candidates = [];
    candidates.push(healer);
    if (primaryBuddy) candidates.push(primaryBuddy);
    if (extraCandidates && extraCandidates.length) candidates.push(...extraCandidates);

    let best = null;
    let bestScore = -Infinity;

    for (const t of candidates) {
        if (!t) continue;

        const r = getHealRange(healer, t);
        // Can we heal it this tick?
        if (r > 3) continue;

        const s = healUrgencyScore(t, healer);
        if (s > bestScore) {
            bestScore = s;
            best = t;
        }
    }

    return best;
}

function pushHealAction(actions, healer, target) {
    if (!target) return;

    const r = getHealRange(healer, target);
    if (r <= 1) actions.push({ action: 'heal', targetId: target.id });
    else if (r <= 3) actions.push({ action: 'rangedHeal', targetId: target.id });
}




function buildLeaderActions(creep, buddy, target, suppressCombat) {
    const actions = [];

    // Better healing: self vs buddy based on urgency
    const healTarget = chooseBestHealTarget(creep, buddy);
    pushHealAction(actions, creep, healTarget);

    if (suppressCombat || !target) return actions;

    const range = creep.pos.getRangeTo(target);
    const hasRanged = creep.getActiveBodyparts(RANGED_ATTACK) > 0;
    const hasMelee = creep.getActiveBodyparts(ATTACK) > 0;

    if (hasRanged && range <= 3) actions.push({ action: 'rangedAttack', targetId: target.id });
    else if (hasMelee && range <= 1) actions.push({ action: 'attack', targetId: target.id });

    return actions;
}

function buildSupportActions(creep, leader, target, suppressCombat) {
    const actions = [];

    const healTarget = chooseBestHealTarget(creep, leader);
    pushHealAction(actions, creep, healTarget);

    if (suppressCombat) return actions;

    // ...keep your existing attack target selection logic...
    // (unchanged)
    let attackTarget = null;
    if (target && target.pos && target.pos.roomName === creep.room.name) {
        attackTarget = target;
    } else {
        const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
        const structures = creep.room.find(FIND_HOSTILE_STRUCTURES);
        if ((hostiles && hostiles.length > 0) || (structures && structures.length > 0)) {
            attackTarget = creep.pos.findClosestByRange(hostiles.concat(structures));
        }
    }

    if (attackTarget) {
        const range = creep.pos.getRangeTo(attackTarget);
        const hasRanged = creep.getActiveBodyparts(RANGED_ATTACK) > 0;
        const hasMelee = creep.getActiveBodyparts(ATTACK) > 0;
        if (hasRanged && range <= 3) actions.push({ action: 'rangedAttack', targetId: attackTarget.id });
        else if (hasMelee && range <= 1) actions.push({ action: 'attack', targetId: attackTarget.id });
    }

    return actions;
}

function planLeader(creep, runtime, target, routeTarget, options) {
    const opts = options || {};
    let moveTarget = opts.moveTarget || routeTarget;
    let range = opts.range || 1;
    return {
        moveTarget: moveTarget ? { x: moveTarget.x, y: moveTarget.y, roomName: moveTarget.roomName } : null,
        range,
        actions: buildLeaderActions(creep, opts.buddy, target, opts.suppressCombat)
    };
}

function planSupport(creep, runtime, leader, target, avoidMelee, options) {
    const opts = options || {};
    let moveTarget = opts.moveTarget || (leader ? leader.pos : null);
    let range = opts.range || 1;
    if (avoidMelee && !opts.range) range = 2;
    return {
        moveTarget: moveTarget ? { x: moveTarget.x, y: moveTarget.y, roomName: moveTarget.roomName } : null,
        range,
        actions: buildSupportActions(creep, leader, target, opts.suppressCombat)
    };
}

module.exports = {
    planLeader,
    planSupport
};
