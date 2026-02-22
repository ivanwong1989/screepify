function buildActions(creep, target) {
    const actions = [];
    if (creep.getActiveBodyparts(HEAL) > 0) {
        actions.push({ action: 'heal', targetId: creep.id });
    }

    if (!target) return actions;

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

function plan(creep, runtime, target, routeTarget) {
    let moveTarget = routeTarget;
    let range = 1;

    if (runtime.phase === 'ENGAGE' && target) {
        moveTarget = target.pos;
        range = creep.getActiveBodyparts(RANGED_ATTACK) > 0 ? 3 : 1;
    } else if (moveTarget) {
        range = runtime.phase === 'RETREAT' ? 2 : 1;
    }

    return {
        moveTarget: moveTarget ? { x: moveTarget.x, y: moveTarget.y, roomName: moveTarget.roomName } : null,
        range,
        actions: buildActions(creep, target)
    };
}

module.exports = {
    plan
};
