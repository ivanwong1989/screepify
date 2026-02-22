const memory = require('managers_admiral_tactics_assault_common_memory');
const flagsResolver = require('managers_admiral_tactics_assault_common_flags');
const aoResolver = require('managers_admiral_tactics_assault_common_ao');
const route = require('managers_admiral_tactics_assault_solo_route');
const engage = require('managers_admiral_tactics_assault_solo_engage');
const actionPlan = require('managers_admiral_tactics_assault_solo_actionPlan');

const RETREAT_AT = 0.3;
const REENGAGE_AT = 0.7;

function advanceWaypoint(creep, runtime, waypoints) {
    if (!Array.isArray(waypoints) || waypoints.length === 0) return;
    let index = Number(runtime.waypointIndex) || 0;
    if (index >= waypoints.length) return;
    const wp = waypoints[index];
    if (wp.roomName === creep.room.name && creep.pos.inRangeTo(wp.x, wp.y, 1)) {
        runtime.waypointIndex = Math.min(index + 1, waypoints.length);
    }
}

function isInRange(creep, pos, range) {
    if (!pos || creep.room.name !== pos.roomName) return false;
    return creep.pos.inRangeTo(pos.x, pos.y, range);
}

function shouldRetreat(creep) {
    return creep.hitsMax > 0 && (creep.hits / creep.hitsMax) <= RETREAT_AT;
}

function shouldReengage(creep) {
    return creep.hitsMax > 0 && (creep.hits / creep.hitsMax) >= REENGAGE_AT;
}

function updatePhase(creep, runtime, flags, ao) {
    const waypoints = flags.waypointPositions || [];

    if (runtime.phase === 'RENDEZVOUS') {
        if (!flags.waitPos || isInRange(creep, flags.waitPos, 1)) {
            runtime.phase = 'STAGE';
        }
    }

    if (runtime.phase === 'STAGE') {
        advanceWaypoint(creep, runtime, waypoints);
        const waypointDone = (Number(runtime.waypointIndex) || 0) >= waypoints.length;
        if (waypointDone) {
            if (!flags.assemblyPos || isInRange(creep, flags.assemblyPos, 1)) {
                runtime.phase = 'ENGAGE';
            }
        }
    }

    if (runtime.phase === 'ENGAGE') {
        if (shouldRetreat(creep)) runtime.phase = 'RETREAT';
    }

    if (runtime.phase === 'RETREAT') {
        if (shouldReengage(creep) && flags.waitPos && isInRange(creep, flags.waitPos, 2)) {
            runtime.phase = 'STAGE';
        } else if (shouldReengage(creep) && !flags.waitPos && ao.centerPos && isInRange(creep, ao.centerPos, 3)) {
            runtime.phase = 'STAGE';
        }
    }
}

function run(creep, mission, context) {
    const runtime = memory.getRuntime(mission.name);
    const flags = flagsResolver.resolveFlags(mission);
    const ao = aoResolver.resolveAO(mission, flags);

    updatePhase(creep, runtime, flags, ao);

    const routeTarget = route.getRouteTarget(creep, runtime, flags, ao);
    const target = runtime.phase === 'ENGAGE' ? engage.selectTarget(creep, flags, ao) : null;
    return actionPlan.plan(creep, runtime, target, routeTarget);
}

module.exports = {
    run
};
