function buildActions(creep, target) {
    const actions = [];

    // Always self-heal if possible
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

/**
 * Enhanced plan:
 * - Keeps original behavior
 * - Allows soloPlanner to override movement cleanly
 */
function plan(creep, runtime, target, routeTarget, moveOverride) {
    let moveTarget = routeTarget;
    let range = 1;

    // Default behavior
    if (runtime.phase === 'ENGAGE' && target) {
        moveTarget = target.pos;
        range = creep.getActiveBodyparts(RANGED_ATTACK) > 0 ? 3 : 1;
    } else if (moveTarget) {
        range = runtime.phase === 'RETREAT' ? 2 : 1;
    }

    // ✅ Movement override from soloPlanner
    if (moveOverride) {
        // HOLD: planner explicitly wants no movement this tick
        if (!moveOverride.moveTarget && moveOverride.range === 0) {
            return {
                moveTarget: null,
                range: 0,
                actions: buildActions(creep, target)
            };
        }

        if (moveOverride.moveTarget) {
            moveTarget = moveOverride.moveTarget;
            if (typeof moveOverride.range === 'number') range = moveOverride.range;
        }
    }

    return {
        moveTarget: moveTarget
            ? { x: moveTarget.x, y: moveTarget.y, roomName: moveTarget.roomName }
            : null,
        range,
        actions: buildActions(creep, target)
    };
}

module.exports = {
    plan
};