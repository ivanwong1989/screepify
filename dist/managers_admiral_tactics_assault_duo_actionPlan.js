const { getHostilesInRoom, filterOutAllies } = require('managers_admiral_tactics_assault_common_threat');


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

function chooseBestHealTarget(healer, primaryBuddy, extraCandidates, forcePreHeal) {
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
        if (r > 3) continue;

        const s = healUrgencyScore(t, healer);
        if (s > bestScore) {
            bestScore = s;
            best = t;
        }
    }

    // --- PRE-HEAL LOGIC ---
    // If no one needs healing but we're in danger, self-heal anyway.
    if ((!best || bestScore <= 0) && forcePreHeal) {
        return healer;
    }

    return best;
}

function pushHealAction(actions, healer, target) {
    if (!target) return;

    const r = getHealRange(healer, target);
    if (r <= 1) actions.push({ action: 'heal', targetId: target.id });
    else if (r <= 3) actions.push({ action: 'rangedHeal', targetId: target.id });
}

function resolveMeleeHealAttackConflict(actions, creep) {
    if (!actions || actions.length < 2 || !creep) return;

    const healIdx = actions.findIndex(a => a && a.action === 'heal');
    const attackIdx = actions.findIndex(a => a && a.action === 'attack');
    if (healIdx < 0 || attackIdx < 0) return;

    // ATTACK and melee HEAL both consume the same action slot in this model.
    // - Full HP: prefer damage output (attack).
    // - Injured: keep pre-heal and drop melee attack.
    if (creep.hits >= creep.hitsMax) actions.splice(healIdx, 1);
    else actions.splice(attackIdx, 1);
}

function isHostileCreepTarget(target) {
    if (!target) return false;
    if (typeof target.getActiveBodyparts !== 'function') return false;
    if (!target.owner || typeof target.owner.username !== 'string') return false;
    return !target.my;
}

function pushRangedOffenseAction(actions, creep, target, range) {
    if (!actions || !creep) return;
    if (creep.getActiveBodyparts(RANGED_ATTACK) <= 0) return;

    // Doctrine:
    // - If target is a hostile creep, use focused rangedAttack.
    // - Otherwise (structures / no creep target), default to rangedMassAttack.
    if (target && isHostileCreepTarget(target)) {
        if (range <= 3) actions.push({ action: 'rangedAttack', targetId: target.id });
        return;
    }

    actions.push({ action: 'rangedMassAttack' });
}




function buildLeaderActions(creep, buddy, target, suppressCombat) {
    const actions = [];

    // Better healing: self vs buddy based on urgency
    //const inDanger = hasAdjacentHostile(creep); always preheal
    const healTarget = chooseBestHealTarget(creep, buddy, null, true);
    pushHealAction(actions, creep, healTarget);

    if (suppressCombat || !target) return actions;

    const range = creep.pos.getRangeTo(target);
    const hasMelee = creep.getActiveBodyparts(ATTACK) > 0;

    // Hybrid attackers can use both ATTACK and ranged intent in the same tick.
    if (hasMelee && range <= 1) actions.push({ action: 'attack', targetId: target.id });
    pushRangedOffenseAction(actions, creep, target, range);
    resolveMeleeHealAttackConflict(actions, creep);

    return actions;
}

function buildSupportActions(creep, leader, target, suppressCombat) {
    const actions = [];

    //const inDanger = hasAdjacentHostile(creep);  We want to always pre-heal
    const healTarget = chooseBestHealTarget(creep, leader, null, true);
    pushHealAction(actions, creep, healTarget);

    if (suppressCombat) return actions;

    // ...keep your existing attack target selection logic...
    // (only change is ally-safe hostiles/structures selection)
    let attackTarget = null;
    if (target && target.pos && target.pos.roomName === creep.room.name) {
        attackTarget = target;
    } else {
        // ✅ Ally-safe:
        // - hostiles: uses cache if available, otherwise filters allies from FIND_HOSTILE_CREEPS
        // - structures: filter allies out too (important if your cache includes ally-owned)
        const hostiles = getHostilesInRoom(creep.room);
        const structures = filterOutAllies(creep.room.find(FIND_HOSTILE_STRUCTURES) || []);
        const ramparts = structures.filter(s => s && s.structureType === STRUCTURE_RAMPART);
        const nonWallStructures = structures.filter(s => s && s.structureType !== STRUCTURE_RAMPART && s.structureType !== STRUCTURE_WALL);
        const walls = structures.filter(s => s && s.structureType === STRUCTURE_WALL);

        if (ramparts.length > 0) {
            attackTarget = creep.pos.findClosestByRange(ramparts);
        } else if (hostiles && hostiles.length > 0) {
            attackTarget = creep.pos.findClosestByRange(hostiles);
        } else if (nonWallStructures.length > 0) {
            attackTarget = creep.pos.findClosestByRange(nonWallStructures);
        } else if (walls.length > 0) {
            attackTarget = creep.pos.findClosestByRange(walls);
        }
    }

    if (attackTarget) {
        const range = creep.pos.getRangeTo(attackTarget);
        const hasMelee = creep.getActiveBodyparts(ATTACK) > 0;
        if (hasMelee && range <= 1) actions.push({ action: 'attack', targetId: attackTarget.id });
        pushRangedOffenseAction(actions, creep, attackTarget, range);
    } else {
        // No focused target: default to area pressure if we have ranged parts.
        pushRangedOffenseAction(actions, creep, null, Infinity);
    }
    resolveMeleeHealAttackConflict(actions, creep);

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
