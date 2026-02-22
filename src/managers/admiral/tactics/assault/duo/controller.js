const memory = require('managers_admiral_tactics_assault_common_memory');
const flagsResolver = require('managers_admiral_tactics_assault_common_flags');
const aoResolver = require('managers_admiral_tactics_assault_common_ao');
const rendezvous = require('managers_admiral_tactics_assault_duo_rendezvous');
const engage = require('managers_admiral_tactics_assault_duo_engage');
const actionPlan = require('managers_admiral_tactics_assault_duo_actionPlan');
const duoPlanner = require('managers_admiral_tactics_assault_duo_duoPlanner_duoPlanner');
const threatEval = require('managers_admiral_tactics_assault_common_threat');

const RETREAT_AT = 0.3;
const REENGAGE_AT = 0.7;
const COHESION_RANGE = 1;
const WIPE_TTL = 15;

function formatPos(pos) {
    if (!pos) return 'null';
    const roomName = pos.roomName || (pos.room && pos.room.name) || 'unknown';
    const x = pos.x;
    const y = pos.y;
    if (x == null || y == null) return `${roomName}:?,?`;
    return `${roomName}:${x},${y}`;
}

function formatCreep(creep) {
    if (!creep) return 'null';
    return `${creep.name}@${formatPos(creep.pos)}(${creep.hits}/${creep.hitsMax})`;
}

function logDuo(runtime, mission, message) {
    if (!global || typeof global.debug !== 'function') return;
    const missionName = mission && mission.name ? mission.name : 'unknown';
    global.debug('admiral.assault.duo', `[assault.duo] mission=${missionName} ${message}`);
    if (runtime && runtime.debug) runtime.debug.lastLog = message;
}

function shouldRetreat(creep) {
    return creep && creep.hitsMax > 0 && (creep.hits / creep.hitsMax) <= RETREAT_AT;
}

function shouldReengage(creep) {
    return creep && creep.hitsMax > 0 && (creep.hits / creep.hitsMax) >= REENGAGE_AT;
}


function inferRoleFromMissionName(creep) {
    if (!creep || !creep.memory) return null;

    var m = creep.memory.missionName;
    if (!m || typeof m !== 'string') return null;

    // string suffix check without endsWith (extra safe)
    if (m.slice(-7) === ':leader') return 'leader';
    if (m.slice(-8) === ':support') return 'support';

    return null;
}

function inferRole(creep) {
    if (creep && creep.memory && creep.memory.assaultRole) return creep.memory.assaultRole;
    return inferRoleFromMissionName(creep);
}

function resolveLeaderSupport(leaderInput, supportInput) {
    var leader = leaderInput || null;
    var support = supportInput || null;

    var lRole = inferRole(leader);
    var sRole = inferRole(support);

    // If the "leader" we were handed is actually support, swap
    if (leader && lRole === 'support') {
        var tmp = leader;
        leader = support;
        support = tmp;
        // recompute roles after swap
        lRole = inferRole(leader);
        sRole = inferRole(support);
    }

    // If the "support" we were handed is actually leader, swap
    if (support && sRole === 'leader') {
        var tmp2 = leader;
        leader = support;
        support = tmp2;
    }

    // Still ambiguous? pick deterministically by name so it doesn't flip
    if (leader && support) {
        var ln = String(leader.name || '');
        var sn = String(support.name || '');
        if (ln > sn) {
        var tmp3 = leader;
        leader = support;
        support = tmp3;
        }
    }

    return { leader: leader, support: support };
}

function advanceWaypoint(runtime, leader, support, waypoints) {
    if (!Array.isArray(waypoints) || waypoints.length === 0) return;
    const index = Number(runtime.route && runtime.route.waypointIndex) || 0;
    if (index >= waypoints.length) return;
    const wp = waypoints[index];
    if (!leader || !support) return;
    if (leader.room.name !== wp.roomName || support.room.name !== wp.roomName) return;
    // allow formation arrival within range 2 of waypoint
    if (leader.pos.inRangeTo(wp.x, wp.y, 2) &&
        support.pos.inRangeTo(wp.x, wp.y, 2)) {

        if (leader.pos.getRangeTo(support.pos) <= COHESION_RANGE) {
            runtime.route.waypointIndex =
                Math.min(index + 1, waypoints.length);
        }
    }
}

function getRouteTarget(runtime, flags, ao) {
    if (runtime.phase === 'ASSEMBLE') return flags.assemblyPos || flags.waitPos || ao.centerPos;
    if (runtime.phase === 'ROUTE') {
        const waypoints = flags.waypointPositions || [];
        const index = Number(runtime.route && runtime.route.waypointIndex) || 0;
        if (waypoints[index]) return waypoints[index];
        return flags.attackPos || ao.centerPos;
    }
    if (runtime.phase === 'ENGAGE') return flags.attackPos || ao.centerPos;
    if (runtime.phase === 'RETREAT') return flags.waitPos || flags.assemblyPos || ao.centerPos;
    return flags.waitPos || ao.centerPos;
}

function computeRegroup(leader, support, cohesionRange) {
    if (!leader || !support) return false;
    if (leader.room.name !== support.room.name) return true;
    const range = Number.isFinite(cohesionRange) ? cohesionRange : COHESION_RANGE;
    return leader.pos.getRangeTo(support.pos) > range;
}

function handleWipe(runtime, leader, support, now) {
    if (leader || support) {
        runtime.wipe.lastFullMissingAt = 0;
        return { reset: false };
    }
    if (!runtime.wipe.lastFullMissingAt) runtime.wipe.lastFullMissingAt = now;
    if (now - runtime.wipe.lastFullMissingAt >= WIPE_TTL) {
        return { reset: true };
    }
    return { reset: false };
}

function shouldExitRetreat(runtime, leader, support, flags) {
    if (!leader || !support) return false;
    if (!shouldReengage(leader) || !shouldReengage(support)) return false;
    if (!flags.waitPos) return true;
    return leader.pos.inRangeTo(flags.waitPos.x, flags.waitPos.y, 2) && support.pos.inRangeTo(flags.waitPos.x, flags.waitPos.y, 2);
}


function planForPair(mission, leaderInput, supportInput, context) {
    const runtimeKey = mission && mission.data && mission.data.squadKey ? mission.data.squadKey : mission.name;
    let runtime = memory.getDuoRuntime(runtimeKey);
    if (!runtime.debug) runtime.debug = {};
    const flags = flagsResolver.resolveFlags(mission);
    const ao = aoResolver.resolveAO(mission, flags);
    const now = typeof Game !== 'undefined' ? Game.time : 0;

    const resolved = resolveLeaderSupport(leaderInput, supportInput);
    let leader = resolved.leader;
    let support = resolved.support;

    const prevPhase = runtime.phase;
    const wipe = handleWipe(runtime, leader, support, now);
    if (wipe.reset) {
        runtime = memory.resetDuoRuntime(runtimeKey);
        if (!runtime.debug) runtime.debug = {};
        logDuo(runtime, mission, `wipe=reset at=${now}`);
    }

    runtime.squad.leaderId = leader ? leader.id : null;
    runtime.squad.supportId = support ? support.id : null;

    if (!runtime.assembled.done) {
        if (rendezvous.isAssembled(leader, support, flags.assemblyPos)) {
            runtime.assembled.done = true;
            runtime.assembled.at = now;
            runtime.assembled.pos = flags.assemblyPos ? { x: flags.assemblyPos.x, y: flags.assemblyPos.y, roomName: flags.assemblyPos.roomName } : null;
            runtime.spawn.allow = false;
            runtime.spawn.lastAllowAt = now;
            runtime.phase = (flags.waypointPositions && flags.waypointPositions.length > 0) ? 'ROUTE' : 'ENGAGE';
            logDuo(runtime, mission, `assembled=1 at=${now} pos=${formatPos(flags.assemblyPos)} phase=${runtime.phase}`);
        } else {
            runtime.phase = 'ASSEMBLE';
            runtime.spawn.allow = true;
            runtime.spawn.lastAllowAt = now;
        }
    } else {
        runtime.spawn.allow = false;
        if (runtime.phase === 'ASSEMBLE') {
            runtime.phase = (flags.waypointPositions && flags.waypointPositions.length > 0) ? 'ROUTE' : 'ENGAGE';
        }
    }

    if (runtime.assembled.done) {
        if (runtime.phase !== 'RETREAT' && (shouldRetreat(leader) || shouldRetreat(support))) {
            runtime.phase = 'RETREAT';
        } else if (runtime.phase === 'RETREAT' && shouldExitRetreat(runtime, leader, support, flags)) {
            runtime.phase = (flags.waypointPositions && flags.waypointPositions.length > 0) ? 'ROUTE' : 'ENGAGE';
        }
    }

    const threat = threatEval.evaluateThreat(leader, support);
    let cohesionRange = COHESION_RANGE;
    let splitRetreat = false;
    if (runtime.phase === 'RETREAT' || (threat && threat.level >= 2)) {
        cohesionRange = 3;
    }
    if (runtime.phase === 'RETREAT' && (shouldRetreat(leader) || shouldRetreat(support)) && threat && threat.level >= 2) {
        cohesionRange = 999;
        splitRetreat = true;
    }
    if (runtime.phase === 'ASSEMBLE' || runtime.phase === 'ROUTE') {
        cohesionRange = COHESION_RANGE;
        splitRetreat = false;
    }

    let baseRegroup = false;
    if (runtime.assembled.done && (!leader || !support)) {
        runtime.phase = 'RETREAT';
        baseRegroup = false;
    } else {
        baseRegroup = computeRegroup(leader, support, cohesionRange);
    }
    const strictBroken = leader && support && leader.room.name === support.room.name && leader.pos.getRangeTo(support.pos) > 1 && !splitRetreat;
    if (strictBroken) baseRegroup = true;

    if (runtime.assembled.done) {
        if (runtime.phase === 'ROUTE') {
            if (!baseRegroup) {
                advanceWaypoint(runtime, leader, support, flags.waypointPositions || []);
            }
            const index = Number(runtime.route && runtime.route.waypointIndex) || 0;
            if (index >= (flags.waypointPositions || []).length) {
                runtime.phase = 'ENGAGE';
            }
        }
    }

    if (runtime.phase !== prevPhase) {
        logDuo(runtime, mission, `phase=${prevPhase}->${runtime.phase} leader=${formatCreep(leader)} support=${formatCreep(support)}`);
    }

    const routeTarget = getRouteTarget(runtime, flags, ao);
    const rallyPos = flags.assemblyPos || flags.waitPos || routeTarget;
    const engageActor = leader || support;
    const target = runtime.phase === 'ENGAGE' && engageActor ? engage.selectTarget(engageActor, flags, ao) : null;
    const move = duoPlanner.plan({
        leader,
        support,
        memoryKey: `duo:${runtimeKey}`,
        goal: {
            pos: routeTarget,
            type: 'RANGE',
            range: 1
        },
        formation: {
            cohesionRange,
            anchor: 'leader',
            supportOffset: 'auto',
            allowSwap: true
        },
        movement: {
            allowSplit: splitRetreat,
            usePathCache: true,
            pathReuseTicks: 25,
            stallRepathTicks: 2,
            preferRoads: true
        },
        runtime: {
            roomCallback: runtime.roomCallback || null
        },
        debug: true
    });
    const hasPair = !!(leader && support);

    let leaderTask = null;
    let supportTask = null;
    if (runtime.phase === 'ASSEMBLE' || runtime.phase === 'ROUTE') {
        const suppressCombat = true;
        runtime.regroup = hasPair ? (move.mode === 'REGROUP' || !move.cohesive) : baseRegroup;

        if (leader) {
            leaderTask = actionPlan.planLeader(leader, runtime, null, routeTarget, {
                suppressCombat
            });
        }
        if (support) {
            supportTask = actionPlan.planSupport(support, runtime, leader, null, false, {
                suppressCombat
            });
        }
    } else {
        const avoidMelee = !!(target && leader && leader.pos.getRangeTo(target) <= 1);
        runtime.regroup = hasPair ? (move.mode === 'REGROUP' || !move.cohesive) : baseRegroup;
        const suppressCombat = runtime.phase === 'ASSEMBLE' || runtime.regroup;
        if (leader) {
            leaderTask = actionPlan.planLeader(leader, runtime, target, routeTarget, {
                suppressCombat
            });
        }
        if (support) {
            supportTask = actionPlan.planSupport(support, runtime, leader, target, avoidMelee, {
                suppressCombat
            });
        }
    }

    if (leaderTask) {
        leaderTask.movePlan = {
            step: {
                dir: move.step ? move.step.leaderDir : null,
                to: move.step && move.step.leaderTo ? {
                    x: move.step.leaderTo.x,
                    y: move.step.leaderTo.y,
                    roomName: move.step.leaderTo.roomName
                } : null
            },
            mode: 'PRIMITIVE',
            allowFallbackMoveTo: false
        };
        leaderTask.moveTarget = null;
        leaderTask.range = 0;
    }
    if (supportTask) {
        supportTask.movePlan = {
            step: {
                dir: move.step ? move.step.supportDir : null,
                to: move.step && move.step.supportTo ? {
                    x: move.step.supportTo.x,
                    y: move.step.supportTo.y,
                    roomName: move.step.supportTo.roomName
                } : null
            },
            mode: 'PRIMITIVE',
            allowFallbackMoveTo: false
        };
        supportTask.moveTarget = null;
        supportTask.range = 0;
    }

    if (runtime.debug.lastLogTick !== now) {
        runtime.debug.lastLogTick = now;
        const dist = leader && support ? leader.pos.getRangeTo(support.pos) : 'n/a';
        const waypointIndex = Number(runtime.route && runtime.route.waypointIndex) || 0;
        const waypoints = flags.waypointPositions || [];
        const rallyPos = flags.assemblyPos || flags.waitPos;
        const targetLabel = target ? `${target.id}@${formatPos(target.pos)}` : 'none';
        const leaderNext = move.step ? move.step.leaderTo : null;
        const supportNext = move.step ? move.step.supportTo : null;
        const spinCount = runtime.formation && Number.isFinite(runtime.formation.spinCount) ? runtime.formation.spinCount : 0;
        const cohesive = move ? (move.cohesive ? 1 : 0) : (leader && support ? (leader.pos.getRangeTo(support.pos) <= COHESION_RANGE ? 1 : 0) : 0);
        const allowStep = move && move.step && (move.step.leaderDir || move.step.supportDir) ? 1 : 0;
        const mode = move ? move.mode : runtime.phase;
        const hasTargetPos = target ? 1 : 0;
        const hasRouteTarget = routeTarget ? 1 : 0;
        const predictedSeparation = 0;
        const suppressCombat = runtime.phase === 'ASSEMBLE' || runtime.phase === 'ROUTE' || runtime.regroup ? 1 : 0;
        const lfat = leader ? leader.fatigue || 0 : 0;
        const sfat = support ? support.fatigue || 0 : 0;
        const rej = (move && move.debug && move.debug.rejects)
                    ? JSON.stringify(move.debug.rejects)
                    : '';
        const reason =
        (move && move.step && move.step.reason) ? move.step.reason :
        (move && move.debug && move.debug.reason) ? move.debug.reason :
        (move && move.reason) ? move.reason :
        '';

        // SAFE: leader/support might be null this tick
        const lRole = leader && leader.memory ? (leader.memory.role || '') : '';
        const sRole = support && support.memory ? (support.memory.role || '') : '';
        const lIsLeader = leader && leader.memory && leader.memory.isLeader ? 1 : 0;
        const sIsLeader = support && support.memory && support.memory.isLeader ? 1 : 0;

        const lId = leader && leader.id ? String(leader.id).slice(-4) : '----';
        const sId = support && support.id ? String(support.id).slice(-4) : '----';

        const lName = leader ? (leader.name || 'none') : 'none';
        const sName = support ? (support.name || 'none') : 'none';

        const lPos = leader ? `${leader.pos.roomName}:${leader.pos.x},${leader.pos.y}` : 'none';
        const sPos = support ? `${support.pos.roomName}:${support.pos.x},${support.pos.y}` : 'none';
        const lInf = inferRoleFromMissionName(leader);
        const sInf = inferRoleFromMissionName(support);
        const who =
        ` L=${lName}[${lId}] isLeader=${lIsLeader} role=${lRole} @${lPos}` +
        ` | S=${sName}[${sId}] isLeader=${sIsLeader} role=${sRole} @${sPos}`;
        logDuo(
            runtime,
            mission,
            `phase=${runtime.phase} mode=${mode} allowStep=${allowStep} assembled=${runtime.assembled.done ? 1 : 0} spawnAllow=${runtime.spawn.allow ? 1 : 0} cohesive=${cohesive} dist=${dist} regroup=${runtime.regroup ? 1 : 0} hasTargetPos=${hasTargetPos} hasRouteTarget=${hasRouteTarget} predSep=${predictedSeparation} suppress=${suppressCombat} Lfat=${lfat} Sfat=${sfat} Lnext=${formatPos(leaderNext)} Snext=${formatPos(supportNext)} spin=${spinCount} rally=${formatPos(rallyPos)} routeTarget=${formatPos(routeTarget)} waypoint=${waypointIndex}/${waypoints.length} leader=${formatCreep(leader)} support=${formatCreep(support)} target=${targetLabel} rej=${rej} reason=${reason} who=${who}`
        );
    }

    return {
        leaderTask,
        supportTask,
        runtime,
        debug: runtime.debug || {}
    };
}

module.exports = {
    planForPair
};
