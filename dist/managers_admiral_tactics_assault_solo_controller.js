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


function getRuntimeKey(mission) {
    return (mission && mission.data && mission.data.squadKey) ? mission.data.squadKey : (mission ? mission.name : 'unknown');
}

function nowTick() {
    return (typeof Game !== 'undefined' && Game.time != null) ? Game.time : 0;
}

function ensureSoloAssembleState(runtime) {
    if (!runtime.assembled || typeof runtime.assembled !== 'object') {
        runtime.assembled = { done: false, at: 0, pos: null };
    }
}

function isSoloAssembled(creep, flags) {
    if (!creep) return false;

    // Prefer assemblyPos if present, else waitPos (W)
    const p = flags && (flags.assemblyPos || flags.waitPos);
    if (!p) return false;

    // Match duo-ish semantics: "arrived" within range 1
    return creep.room.name === p.roomName && creep.pos.inRangeTo(p.x, p.y, 1);
}

function getSoloAssembleTarget(flags) {
    // Strict preference order during assemble:
    // 1) assemblyPos (Y, if you use it)
    // 2) waitPos (W)
    // 3) first waypoint (if any)
    // (avoid ao.centerPos here; that often points at A)
    if (!flags) return null;
    if (flags.assemblyPos) return flags.assemblyPos;
    if (flags.waitPos) return flags.waitPos;
    const wps = flags.waypointPositions || [];
    if (wps[0]) return wps[0];
    return null;
}

function handleSoloWipe(runtime, creep, now) {
    if (!runtime.wipe) runtime.wipe = {};

    // If creep exists, clear any wipe marker
    if (creep) {
        runtime.wipe.lastMissingAt = 0;
        return { reset: false };
    }

    // No TTL: if we've previously assembled (or progressed beyond initial state) and the creep is gone,
    // treat it as a wipe immediately so contracts can fulfill again.
    const assembledDone = !!(runtime.assembled && runtime.assembled.done);
    const phase = runtime.phase || 'RENDEZVOUS';
    const progressed = assembledDone || phase !== 'RENDEZVOUS' || (Number(runtime.waypointIndex) || 0) > 0;

    if (progressed) {
        runtime.wipe.lastMissingAt = now;
        return { reset: true };
    }

    // Still idle / never spawned: don't churn runtime every tick
    return { reset: false };
}

function resetSoloRuntimeState(runtime) {
    // Reset mission state fully (Rendezvous/Assemble semantics)
    runtime.phase = 'RENDEZVOUS';
    runtime.waypointIndex = 0;

    // Reset assemble gate (duo-consistent)
    ensureSoloAssembleState(runtime);
    runtime.assembled.done = false;
    runtime.assembled.at = 0;
    runtime.assembled.pos = null;

    // Ensure spawning is allowed again (acceptance requirement)
    if (!runtime.spawn || typeof runtime.spawn !== 'object') runtime.spawn = {};
    runtime.spawn.allow = true;

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
    if (!runtime.wipe) runtime.wipe = {};
    runtime.wipe.lastMissingAt = 0;
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
        const now = nowTick();
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

/**
 * SOLO tick driver: runs even if creep is null.
 * - detects full wipe (no TTL)
 * - resets runtime immediately on wipe so respawn follows W/waypoints again
 * - if creep exists, delegates to runCore() (no behavioral change)
 */
function planForSolo(mission, creepOrNull, context) {
    if (!mission) return null;

    const runtimeKey = getRuntimeKey(mission);
    const runtime = memory.getRuntime(runtimeKey);
    memory.touchSoloRuntime(runtime, mission, runtimeKey);

    const ownerRoom =
        (mission && mission.data && (mission.data.sponsorRoom || mission.data.ownerRoom)) || null;

    if (ownerRoom) {
        runtime.meta.ownerRoom = ownerRoom;
    }

    const now = nowTick();

    const wipe = handleSoloWipe(runtime, creepOrNull, now);
    if (wipe.reset) {
        resetSoloRuntimeState(runtime);
        return null;
    }

    // No creep => nothing to plan/assign this tick, but wipe timer was updated above
    if (!creepOrNull) return null;

    // Creep exists => proceed with original SOLO logic
    return runCore(creepOrNull, mission, context, runtime, runtimeKey, now);
}

/**
 * Original SOLO logic (previously in run()), but now assumes creep exists
 * and wipe/reset has already been handled by planForSolo().
 */
function runCore(creep, mission, context, runtime, runtimeKey, now) {
    // ====================
    // 🚪 BOOST GATE (Pre-Assembly Phase)
    // ====================
    const squadKey = mission && mission.data && mission.data.squadKey;

    if (squadKey && !boostGate.runBoostGate(creep, squadKey)) {
        // Still boosting — do NOT run assembly/combat logic
        return null;
    }

    const flags = flagsResolver.resolveFlags(mission); // handles W/Y via mission.data.flags (not inferred)
    const ao = aoResolver.resolveAO(mission, flags);

    // --------------------
    // 🧷 ASSEMBLE GATE
    // --------------------
    ensureSoloAssembleState(runtime);

    if (!runtime.assembled.done) {
        if (isSoloAssembled(creep, flags)) {
            runtime.assembled.done = true;
            runtime.assembled.at = now;
            const p = flags.assemblyPos || flags.waitPos;
            runtime.assembled.pos = p ? { x: p.x, y: p.y, roomName: p.roomName } : null;

            // NEW: once assembled, lock spawning (prevents extra creeps)
            if (!runtime.spawn || typeof runtime.spawn !== 'object') runtime.spawn = {};
            runtime.spawn.allow = false;
            runtime.spawn.lastAllowAt = now;

            // Once assembled, proceed into staging/waypoint logic
            if (!runtime.phase || runtime.phase === 'RENDEZVOUS') {
                runtime.phase = 'STAGE';
            }
        } else {
            // Force rendezvous until assembled
            runtime.phase = 'RENDEZVOUS';
        }
    }

    // Only advance phases once assembled (prevents "waitPos missing => STAGE => A")
    if (runtime.assembled.done) {
        updatePhase(creep, runtime, flags, ao);
    }

    // Cross-room / waypoint routing
    let routeTarget;
    if (!runtime.assembled.done) {
        // During assemble, NEVER route to AO center (which can be A-derived)
        routeTarget = getSoloAssembleTarget(flags);
        if (runtime.debug && runtime.debug.soloPlannerVerbose) {
            logSolo(runtime, mission, `assembleGate hold target=${formatPos(routeTarget)} wait=${formatPos(flags.waitPos)} assembly=${formatPos(flags.assemblyPos)}`);
        }
    } else {
        routeTarget = route.getRouteTarget(creep, runtime, flags, ao);
    }

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

/**
 * Backward compatible: existing callers that call run(creep, ...) still work.
 * Internally uses the new tick driver.
 */
function run(creep, mission, context) {
    return planForSolo(mission, creep, context);
}

module.exports = {
    run,
    planForSolo
};