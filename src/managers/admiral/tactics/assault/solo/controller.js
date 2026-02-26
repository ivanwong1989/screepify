const memory = require('managers_admiral_tactics_assault_common_memory');
const flagsResolver = require('managers_admiral_tactics_assault_common_flags');
const aoResolver = require('managers_admiral_tactics_assault_common_ao');
const route = require('managers_admiral_tactics_assault_solo_route');
const engage = require('managers_admiral_tactics_assault_solo_engage');
const actionPlan = require('managers_admiral_tactics_assault_solo_actionPlan');
const boostGate = require('managers_admiral_tactics_boostgate_boostGate');

// 🔥 SOLO MICRO PLANNER
const soloPlanner = require('managers_admiral_tactics_assault_solo_soloPlanner_soloPlanner');

const RETREAT_AT = 0.3;
const REENGAGE_AT = 0.7;

const WIPE_TTL = 4; // same as duos

function handleSoloWipe(runtime, creep, now) {
    if (!runtime.wipe) runtime.wipe = {};

    // If creep exists, clear wipe timer
    if (creep) {
        runtime.wipe.lastMissingAt = 0;
        return { reset: false };
    }

    // Creep missing this tick -> start/continue timer
    if (!runtime.wipe.lastMissingAt) runtime.wipe.lastMissingAt = now;

    // Missing long enough => consider wiped
    if (now - runtime.wipe.lastMissingAt >= WIPE_TTL) {
        return { reset: true };
    }

    return { reset: false };
}

function formatPos(pos) {
    if (!pos) return 'null';
    const roomName = pos.roomName || (pos.room && pos.room.name) || 'unknown';
    const x = pos.x;
    const y = pos.y;
    if (x == null || y == null) return `${roomName}:?,?`;
    return `${roomName}:${x},${y}`;
}

function posKey(pos) {
    if (!pos) return null;
    const roomName = pos.roomName || (pos.room && pos.room.name) || 'unknown';
    if (pos.x == null || pos.y == null) return `${roomName}:?,?`;
    return `${roomName}:${pos.x},${pos.y}`;
}

function logSolo(runtime, mission, message) {
    if (!global || typeof global.debug !== 'function') return;
    const missionName = mission && mission.name ? mission.name : 'unknown';
    global.debug('admiral.assault.solo', `[assault.solo] mission=${missionName} ${message}`);

    if (runtime && runtime.debug) {
        const now = (typeof Game !== 'undefined' && Game.time != null) ? Game.time : 0;
        if (runtime.debug.lastLogTick === now && runtime.debug.lastLog === message) return;
        runtime.debug.lastLogTick = now;
        runtime.debug.lastLog = message;
    }
}

function advanceWaypoint(creep, runtime, waypoints) {
    if (!Array.isArray(waypoints) || waypoints.length === 0) return;

    let index = Number(runtime.waypointIndex) || 0;
    if (index >= waypoints.length) return;

    const wp = waypoints[index];

    if (wp.roomName === creep.room.name &&
        creep.pos.inRangeTo(wp.x, wp.y, 1)) {
        runtime.waypointIndex = index + 1;
    }
}

function isInRange(creep, pos, range) {
    if (!pos || creep.room.name !== pos.roomName) return false;
    return creep.pos.inRangeTo(pos.x, pos.y, range);
}

function shouldRetreat(creep) {
    return creep.hitsMax > 0 &&
        (creep.hits / creep.hitsMax) <= RETREAT_AT;
}

function shouldReengage(creep) {
    return creep.hitsMax > 0 &&
        (creep.hits / creep.hitsMax) >= REENGAGE_AT;
}

function updatePhase(creep, runtime, flags, ao) {
    const waypoints = flags.waypointPositions || [];

    if (!runtime.phase) runtime.phase = 'RENDEZVOUS';

    // RENDEZVOUS → STAGE
    if (runtime.phase === 'RENDEZVOUS') {
        if (!flags.waitPos || isInRange(creep, flags.waitPos, 1)) {
            runtime.phase = 'STAGE';
        }
    }

    // STAGE → ENGAGE
    if (runtime.phase === 'STAGE') {
        advanceWaypoint(creep, runtime, waypoints);

        const waypointDone =
            (Number(runtime.waypointIndex) || 0) >= waypoints.length;

        if (waypointDone) {
            if (!flags.assemblyPos ||
                isInRange(creep, flags.assemblyPos, 1)) {
                runtime.phase = 'ENGAGE';
            }
        }
    }

    // ENGAGE → STAGE if attack flag removed (A/B no longer present)
    if (runtime.phase === 'ENGAGE') {
        if (!flags.attackFlag) {
            runtime.phase = 'STAGE';
            // optional: reset waypoint progress so it re-walks to W properly
            // runtime.waypointIndex = 0;
            return;
        }

        if (shouldRetreat(creep)) {
            runtime.phase = 'RETREAT';
        }
    }

    // RETREAT → STAGE
    if (runtime.phase === 'RETREAT') {
        if (shouldReengage(creep)) {
            if (flags.waitPos && isInRange(creep, flags.waitPos, 2)) {
                runtime.phase = 'STAGE';
            } else if (!flags.waitPos &&
                ao.centerPos &&
                isInRange(creep, ao.centerPos, 3)) {
                runtime.phase = 'STAGE';
            }
        }
    }
}

function run(creep, mission, context) {
    const runtime = memory.getRuntime(mission.name);

    // ====================
    // 💀 SOLO WIPE TRACKER (same concept as duos)
    // ====================
    const now = (typeof Game !== 'undefined') ? Game.time : 0;

    const wipe = handleSoloWipe(runtime, creep, now);
    if (wipe.reset) {
        // Reset mission state fully
        runtime.phase = 'RENDEZVOUS';
        runtime.waypointIndex = 0;

        // Clear any leftover micro/oscillation state
        delete runtime._lastPos;
        delete runtime._prevPos;

        if (runtime.debug) {
            delete runtime.debug.lastPhase;
            delete runtime.debug.lastRouteTarget;
            delete runtime.debug.lastTarget;
            delete runtime.debug.lastMoveTarget;
            delete runtime.debug.lastMoveTarget2;
            delete runtime.debug.lastPos;
            delete runtime.debug.lastPos2;
            delete runtime.debug.oscillateCount;
        }

        // Clear wipe timer so new spawn starts fresh
        runtime.wipe.lastMissingAt = 0;

        return null; // No creep alive this tick
    }

    // If creep missing but not TTL yet, just bail
    if (!creep) return null;

    // ====================
    // 🚪 BOOST GATE (Pre-Assembly Phase)
    // ====================
    const squadKey = mission && mission.data && mission.data.squadKey;

    if (squadKey && !boostGate.runBoostGate(creep, squadKey)) {
        // Still boosting — do NOT run assembly/combat logic
        return null;
    }

    const flags = flagsResolver.resolveFlags(mission); // handles W/Y automatically
    const ao = aoResolver.resolveAO(mission, flags);

    updatePhase(creep, runtime, flags, ao);

    // Cross-room / waypoint routing
    const routeTarget = route.getRouteTarget(creep, runtime, flags, ao);

    // AO-bounded target selection
    const target =
        runtime.phase === 'ENGAGE'
            ? engage.selectTarget(creep, flags, ao)
            : null;

    // Track last position to avoid oscillation
    if (!runtime._lastPos) {
        runtime._lastPos = { x: creep.pos.x, y: creep.pos.y, roomName: creep.room.name };
    } else {
        runtime._prevPos = runtime._lastPos;
        runtime._lastPos = { x: creep.pos.x, y: creep.pos.y, roomName: creep.room.name };
    }

    const enableSoloDebug =
        !!(runtime && runtime.debug && runtime.debug.soloPlannerVerbose);

    // 🧠 SOLO MICRO PLANNING (combat matrix + predictive avoidance)
    const movePlan =
        soloPlanner.plan(
            creep,
            runtime,
            target,
            routeTarget,
            enableSoloDebug ? { prevPos: runtime._prevPos, debug: true } : { prevPos: runtime._prevPos }
        );

    // Let actionPlan handle attack/heal logic.
    // routeTarget stays the "strategic" destination.
    // movePlan (optional) overrides movement for 1-tick micro.
    const plan = actionPlan.plan(
        creep,
        runtime,
        target,
        routeTarget,
        movePlan // <-- 5th param
    );

    // Preserve micro-step precision
    if (movePlan && movePlan.moveTarget) {
        plan.range = movePlan.range;
    }

    // ---- Debug logging for oscillation / target changes ----
    const dbg = runtime.debug || (runtime.debug = {});

    const posNow = posKey(creep.pos);
    const routeKey = posKey(routeTarget);
    const targetKey = target ? `${formatPos(target.pos)}(${target.id})` : null;
    const movePlanKey = movePlan && movePlan.moveTarget ? posKey(movePlan.moveTarget) : null;
    const finalMoveKey = plan && plan.moveTarget ? posKey(plan.moveTarget) : null;

    if (dbg.lastPhase && dbg.lastPhase !== runtime.phase) {
        logSolo(runtime, mission, `phase ${dbg.lastPhase} -> ${runtime.phase}`);
    }

    if (routeKey !== dbg.lastRouteTarget) {
        logSolo(runtime, mission, `routeTarget ${dbg.lastRouteTarget || 'null'} -> ${routeKey || 'null'}`);
    }

    if (targetKey !== dbg.lastTarget) {
        logSolo(runtime, mission, `target ${dbg.lastTarget || 'null'} -> ${targetKey || 'null'}`);
    }

    if (finalMoveKey !== dbg.lastMoveTarget) {
        logSolo(
            runtime,
            mission,
            `moveTarget ${dbg.lastMoveTarget || 'null'} -> ${finalMoveKey || 'null'} ` +
            `range=${plan.range} reason=${(movePlan && movePlan.reason) ? movePlan.reason : 'actionPlan'} ` +
            `route=${routeKey || 'null'} phase=${runtime.phase}`
        );
    }

    if (enableSoloDebug && movePlan && movePlan.debug) {
        const d = movePlan.debug;
        const best = d.best ? `best=${d.best.pos} score=${d.best.score.toFixed(2)} ` +
            `c=${d.best.breakdown.raw} danger=${d.best.breakdown.danger.toFixed(1)} ` +
            `border=${d.best.breakdown.border.toFixed(1)} range=${d.best.breakdown.range.toFixed(1)} ` +
            `dist=${d.best.breakdown.dist.toFixed(1)}` : 'best=null';
        const second = d.second ? `second=${d.second.pos} score=${d.second.score.toFixed(2)} ` +
            `c=${d.second.breakdown.raw} danger=${d.second.breakdown.danger.toFixed(1)} ` +
            `border=${d.second.breakdown.border.toFixed(1)} range=${d.second.breakdown.range.toFixed(1)} ` +
            `dist=${d.second.breakdown.dist.toFixed(1)}` : 'second=null';

        logSolo(
            runtime,
            mission,
            `planner goal=${d.goal} desiredRange=${d.desiredRange} ${best} ${second}`
        );
    }

    if (dbg.lastPos2 && posNow === dbg.lastPos2 && dbg.lastPos && dbg.lastPos !== posNow) {
        dbg.oscillateCount = (Number(dbg.oscillateCount) || 0) + 1;
        logSolo(
            runtime,
            mission,
            `oscillate pos ${dbg.lastPos2} -> ${dbg.lastPos} -> ${posNow} ` +
            `moveTarget=${finalMoveKey || 'null'} route=${routeKey || 'null'} ` +
            `reason=${(movePlan && movePlan.reason) ? movePlan.reason : 'actionPlan'} ` +
            `count=${dbg.oscillateCount}`
        );
    } else {
        dbg.oscillateCount = 0;
    }

    if (dbg.lastMoveTarget2 && finalMoveKey === dbg.lastMoveTarget2 && dbg.lastMoveTarget && dbg.lastMoveTarget !== finalMoveKey) {
        logSolo(
            runtime,
            mission,
            `oscillate moveTarget ${dbg.lastMoveTarget2} -> ${dbg.lastMoveTarget} -> ${finalMoveKey} ` +
            `pos=${posNow} route=${routeKey || 'null'} phase=${runtime.phase}`
        );
    }

    dbg.lastPhase = runtime.phase;
    dbg.lastRouteTarget = routeKey;
    dbg.lastTarget = targetKey;
    dbg.lastMoveTarget2 = dbg.lastMoveTarget;
    dbg.lastMoveTarget = finalMoveKey;
    dbg.lastPos2 = dbg.lastPos;
    dbg.lastPos = posNow;
    dbg.lastTick = now;
    dbg.lastMovePlanTarget = movePlanKey;
    dbg.lastMovePlanReason = movePlan && movePlan.reason ? movePlan.reason : null;

    return plan;
}

module.exports = {
    run
};
