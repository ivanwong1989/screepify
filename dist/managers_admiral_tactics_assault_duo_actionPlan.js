function buildLeaderActions(creep, target, suppressCombat) {
    const actions = [];
    if (creep.getActiveBodyparts(HEAL) > 0) {
        actions.push({ action: 'heal', targetId: creep.id });
    }
    if (suppressCombat || !target) return actions;

    const range = creep.pos.getRangeTo(target);
    const hasRanged = creep.getActiveBodyparts(RANGED_ATTACK) > 0;
    const hasMelee = creep.getActiveBodyparts(ATTACK) > 0;

    if (hasRanged && range <= 3) {
        actions.push({ action: 'rangedAttack', targetId: target.id });
    } else if (hasMelee && range <= 1) {
        actions.push({ action: 'attack', targetId: target.id });
    }
    return actions;
}

function buildSupportActions(creep, leader, target, suppressCombat) {
    const actions = [];
    const healTarget = leader && leader.hits < leader.hitsMax ? leader : creep;
    if (creep.getActiveBodyparts(HEAL) > 0) {
        if (healTarget) {
            const range = creep.pos.getRangeTo(healTarget);
            if (range <= 1) actions.push({ action: 'heal', targetId: healTarget.id });
            else if (range <= 3) actions.push({ action: 'rangedHeal', targetId: healTarget.id });
        }
    }

    if (suppressCombat) return actions;

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
        if (hasRanged && range <= 3) {
            actions.push({ action: 'rangedAttack', targetId: attackTarget.id });
        } else if (hasMelee && range <= 1) {
            actions.push({ action: 'attack', targetId: attackTarget.id });
        }
    }

    return actions;
}

function planLeader(creep, runtime, target, routeTarget, options) {
    const opts = options || {};
    let moveTarget = opts.moveTarget || routeTarget;
    let range = opts.range || 1;
    if (!opts.moveTarget && runtime.phase === 'ENGAGE' && target) {
        moveTarget = target.pos;
        range = creep.getActiveBodyparts(RANGED_ATTACK) > 0 ? 3 : 1;
    }
    return {
        moveTarget: moveTarget ? { x: moveTarget.x, y: moveTarget.y, roomName: moveTarget.roomName } : null,
        range,
        actions: buildLeaderActions(creep, target, opts.suppressCombat)
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
