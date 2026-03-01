const memory = require('managers_admiral_tactics_assault_common_memory');
const flagsResolver = require('managers_admiral_tactics_assault_common_flags');
const aoResolver = require('managers_admiral_tactics_assault_common_ao');
const route = require('managers_admiral_tactics_assault_solo_route');
const engage = require('managers_admiral_tactics_assault_solo_engage');
const soloTactics = require('managers_admiral_tactics_assault_solo_soloTactics');
const actionPlan = require('managers_admiral_tactics_assault_solo_actionPlan');
const boostGate = require('managers_admiral_tactics_boostgate_boostGate');

// 🧭 SOLO PF PLANNER (no micro-step)
const soloPlanner = require('managers_admiral_tactics_assault_solo_soloPlanner_soloPlanner');

const RETREAT_AT = 0.5;
const REENGAGE_AT = 0.95;

// --------------------
// 🧱 DISMANTLE MODE HELPERS
// --------------------
function isDismantleMission(mission) {
    const data = mission && mission.data ? mission.data : null;
    return !!(data && data.assaultMode === 'dismantle');
}

function pickDismantleTarget(creep, ao) {
    if (!creep || !creep.room) return null;

    const radius = ao && Number.isFinite(ao.radius) ? ao.radius : 0;
    const center = ao && ao.centerPos
        ? new RoomPosition(ao.centerPos.x, ao.centerPos.y, ao.centerPos.roomName)
        : null;

    const structures = creep.room.find(FIND_STRUCTURES, {
        filter: s => {
            if (s.my) return false;
            if (s.structureType === STRUCTURE_CONTROLLER) return false;
            if (s.structureType === STRUCTURE_STORAGE) return false;
            if (s.structureType === STRUCTURE_SPAWN) return false;
            if (s.structureType === STRUCTURE_TERMINAL) return false;
            if (s.structureType === STRUCTURE_FACTORY) return false;

            // AO radius enforcement
            if (radius > 0 && center) {
                if (s.pos.roomName !== center.roomName) return false;
                if (center.getRangeTo(s.pos) > radius) return false;
            }

            return true;
        }
    });

    if (!structures.length) return null;

    const priority = [
        STRUCTURE_TOWER,
        STRUCTURE_SPAWN,
        STRUCTURE_EXTENSION,
        STRUCTURE_STORAGE,
        STRUCTURE_TERMINAL,
        STRUCTURE_RAMPART
    ];

    structures.sort((a, b) => {
        const ai = priority.indexOf(a.structureType);
        const bi = priority.indexOf(b.structureType);
        const ap = ai === -1 ? 999 : ai;
        const bp = bi === -1 ? 999 : bi;

        if (ap !== bp) return ap - bp;

        return creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b);
    });

    return structures[0];
}



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

    // ✅ If you have explicit assemblyPos, use it.
    // ✅ Else, treat the LAST waypoint as the effective assembly/stage target.
    // ✅ Else, fall back to waitPos (W).
    const wps = (flags && flags.waypointPositions) ? flags.waypointPositions : [];
    const lastWp = Array.isArray(wps) && wps.length > 0 ? wps[wps.length - 1] : null;

    const p = flags && (flags.assemblyPos || lastWp || flags.waitPos);
    if (!p) return false;

    return creep.room.name === p.roomName && creep.pos.inRangeTo(p.x, p.y, 1);
}

function getSoloAssembleTarget(flags) {
    // Strict preference order during assemble:
    // 1) assemblyPos (Y)
    // 2) first waypoint (W1)  ✅ so we actually walk the chain
    // 3) waitPos (W)
    if (!flags) return null;
    if (flags.assemblyPos) return flags.assemblyPos;

    const wps = flags.waypointPositions || [];
    if (wps[0]) return wps[0];

    if (flags.waitPos) return flags.waitPos;
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

    // Reset waypoint progress trackers (so wipes restart from scratch)
    if (runtime.route && typeof runtime.route === 'object') {
        delete runtime.route.lastReachedWaypoint;
        delete runtime.route.maxWaypointIndex;
    }
    delete runtime._cbWarn;

    if (runtime.debug) {
        delete runtime.debug.lastPhase;
        delete runtime.debug.lastRouteTarget;
        delete runtime.debug.lastTarget;
        delete runtime.debug.lastMoveTarget;
        delete runtime.debug.lastPos;
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
        const next = index + 1;
        runtime.waypointIndex = next;

        // ✅ Remember latest reached waypoint for robust RETREAT/hold behaviour.
        // This prevents snapping all the way back to wait/assembly if waypointPositions
        // are temporarily empty (flag resolution hiccup) or waypointIndex desyncs.
        if (!runtime.route || typeof runtime.route !== 'object') runtime.route = {};
        runtime.route.lastReachedWaypoint = { x: wp.x, y: wp.y, roomName: wp.roomName };

        // Monotonic progress marker (duo-style). Useful even if waypointIndex later resets.
        const prevMax = Number(runtime.route.maxWaypointIndex) || 0;
        runtime.route.maxWaypointIndex = Math.max(prevMax, next);
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


// --------------------
// 🧭 PF CALLBACK WIRING HELPERS
// --------------------
// Resolve the "combat room" where we want to enable expensive combat matrices.
// Prefer AO targetRoom, then attack flag room; fall back to routeTarget room if we have it.
function resolveEngageRoomName(ao, flags, routeTarget) {
    if (ao && ao.targetRoom) return ao.targetRoom;
    if (flags && flags.attackPos && flags.attackPos.roomName) return flags.attackPos.roomName;
    if (routeTarget && routeTarget.roomName) return routeTarget.roomName;
    return null;
}

// Pull callbacks from context.runtime if present, but never hard-crash the whole tick.
// (Throwing here makes missions brittle when tasker wiring changes.)
function wirePathCallbacks(runtime, context) {
    if (!runtime) return;

    const rt = context && context.runtime ? context.runtime : null;
    const travelCb = rt && typeof rt.travelRoomCallback === 'function' ? rt.travelRoomCallback : null;
    const combatCb = rt && typeof rt.combatRoomCallback === 'function' ? rt.combatRoomCallback : null;

    // Only overwrite if we have valid functions (keeps last-known-good if tasker is temporarily inconsistent)
    if (travelCb) runtime.travelRoomCallback = travelCb;
    if (combatCb) runtime.combatRoomCallback = combatCb;

    // Track miswiring for debug (but do not throw)
    if (!travelCb || !combatCb) {
        if (!runtime._cbWarn) runtime._cbWarn = {};
        runtime._cbWarn.missing = {
            travel: !travelCb,
            combat: !combatCb,
            ctxRuntime: !!rt
        };
    } else if (runtime._cbWarn) {
        delete runtime._cbWarn.missing;
    }
}

// Decide which callback is active this tick.
// - Default: travel callback (cheap, stable)
// - Combat callback: only in ENGAGE, inside engage room, and only when there's meaningful combat threat.
//   (Avoid paying combat matrix cost while just walking around or while dismantling structures.)
function selectActiveRoomCallback(runtime, phase, creep, engageRoomName, hasCombatThreat, dismantleMode) {
    const travelCb = runtime && typeof runtime.travelRoomCallback === 'function' ? runtime.travelRoomCallback : null;
    const combatCb = runtime && typeof runtime.combatRoomCallback === 'function' ? runtime.combatRoomCallback : null;

    const inEngageRoom = !engageRoomName || (creep && creep.pos && creep.pos.roomName === engageRoomName);

    if (!dismantleMode &&
        phase === 'ENGAGE' &&
        inEngageRoom &&
        hasCombatThreat &&
        combatCb) {
        return { cb: combatCb, mode: 'combat' };
    }

    if (travelCb) return { cb: travelCb, mode: 'travel' };
    return { cb: null, mode: 'none' };
}

// Retreat destination: latest reached waypoint (not all the way back to W)
function getRetreatWaypoint(runtime, flags, ao) {
    // Prefer cached "latest reached waypoint" (robust even if flags/waypoints fail to resolve for a tick)
    const cached = runtime && runtime.route && runtime.route.lastReachedWaypoint;
    if (cached && cached.roomName && cached.x != null && cached.y != null) return cached;

    const waypoints = (flags && flags.waypointPositions) ? flags.waypointPositions : [];
    if (!Array.isArray(waypoints) || waypoints.length === 0) return null;

    // Prefer monotonic progress marker if present (duo-style), else fall back to waypointIndex
    const maxIdx = runtime && runtime.route ? Number(runtime.route.maxWaypointIndex) : NaN;
    let idx = Number.isFinite(maxIdx) ? maxIdx : Number(runtime && runtime.waypointIndex);

    if (!Number.isFinite(idx) || idx <= 0) return waypoints[0];

    idx = Math.min(idx - 1, waypoints.length - 1);
    return waypoints[idx];
}

function updatePhase(creep, runtime, flags, ao) {
    const waypoints = flags.waypointPositions || [];

    if (!runtime.phase) runtime.phase = 'RENDEZVOUS';
    const dbg = runtime.debug || (runtime.debug = {});

    // RENDEZVOUS → STAGE
    if (runtime.phase === 'RENDEZVOUS') {
        if (!flags.waitPos || isInRange(creep, flags.waitPos, 1)) {
            runtime.phase = 'STAGE';
            dbg.lastPhaseReason = (!flags.waitPos)
                ? 'waitPos missing'
                : `arrived waitPos ${formatPos(flags.waitPos)}`;
        }
    }

    // STAGE → ENGAGE
    if (runtime.phase === 'STAGE') {
        advanceWaypoint(creep, runtime, waypoints);

        const waypointDone =
            (Number(runtime.waypointIndex) || 0) >= waypoints.length;

        if (waypointDone) {
            // IMPORTANT:
            // If waypoints are defined, the last waypoint is the effective "stage gate".
            // We must NOT force a return to the assembly flag (Z/Y) after completing waypoints,
            // otherwise we get: Z -> Z1 Z2 Z3 -> Z -> AO.
            const lastWp = (Array.isArray(waypoints) && waypoints.length > 0)
                ? waypoints[waypoints.length - 1]
                : null;

            const stageGatePos = lastWp || flags.assemblyPos || flags.waitPos;

            if (!stageGatePos || isInRange(creep, stageGatePos, 1)) {
                runtime.phase = 'ENGAGE';
                dbg.lastPhaseReason = !stageGatePos
                    ? 'stage gate missing'
                    : `arrived stageGate ${formatPos(stageGatePos)}`;
            }
        }
    }

    // ENGAGE → STAGE if attack flag removed (A/B no longer present)
    if (runtime.phase === 'ENGAGE') {
        if (!flags.attackFlag) {
            runtime.phase = 'STAGE';
            dbg.lastPhaseReason = 'attack flag missing';
            return;
        }

        if (shouldRetreat(creep)) {
            runtime.phase = 'RETREAT';
            dbg.lastPhaseReason = `low HP ${creep.hits}/${creep.hitsMax}`;
        }
    }

    // RETREAT → ENGAGE (preferred) once healed and returned to the retreat waypoint
    if (runtime.phase === 'RETREAT') {
        if (shouldReengage(creep)) {
            const rp = getRetreatWaypoint(runtime, flags, ao);

            if (rp && isInRange(creep, rp, 2)) {
                // If attack directive exists, resume ENGAGE to AO/attack flag.
                // Otherwise fall back to STAGE.
                runtime.phase = flags.attackFlag ? 'ENGAGE' : 'STAGE';
                dbg.lastPhaseReason = `reengage at retreat waypoint ${formatPos(rp)}`;
            } else if (flags.waitPos && isInRange(creep, flags.waitPos, 2)) {
                // Fallback: legacy behaviour if no waypoints are defined / reachable
                runtime.phase = flags.attackFlag ? 'ENGAGE' : 'STAGE';
                dbg.lastPhaseReason = `reengage at waitPos ${formatPos(flags.waitPos)}`;
            } else if (!flags.waitPos && ao.centerPos && isInRange(creep, ao.centerPos, 3)) {
                runtime.phase = flags.attackFlag ? 'ENGAGE' : 'STAGE';
                dbg.lastPhaseReason = `reengage at ao.centerPos ${formatPos(ao.centerPos)}`;
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
    // ---- PathFinder callback wiring (non-fatal) ----
    wirePathCallbacks(runtime, context);


    const ownerRoom =
        (mission && mission.data && (mission.data.sponsorRoom || mission.data.ownerRoom)) || null;

    if (ownerRoom) {
        runtime.meta.ownerRoom = ownerRoom;
    }

    const now = nowTick();

    const wipe = handleSoloWipe(runtime, creepOrNull, now);
    if (wipe.reset) {
        logSolo(runtime, mission, 'wipe detected: resetting solo runtime state');
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
        const dbg = runtime.debug || (runtime.debug = {});
        if (!dbg.lastBoostBlockAt || (now - dbg.lastBoostBlockAt) >= 5) {
            logSolo(runtime, mission, `boostGate blocking; squadKey=${squadKey}`);
            dbg.lastBoostBlockAt = now;
        }
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

            logSolo(
                runtime,
                mission,
                `assembled at ${formatPos(runtime.assembled.pos)}; spawn.locked=${runtime.spawn && runtime.spawn.allow === false}`
            );
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
        const dbg = runtime.debug || (runtime.debug = {});
        const assembleKey = posKey(routeTarget);
        if (assembleKey !== dbg.lastAssembleTarget) {
            logSolo(
                runtime,
                mission,
                `assembleGate hold target=${formatPos(routeTarget)} wait=${formatPos(flags.waitPos)} assembly=${formatPos(flags.assemblyPos)}`
            );
            dbg.lastAssembleTarget = assembleKey;
        }
    } else {
        // During RETREAT, do NOT snap back to W. Retreat to the latest reached waypoint instead.
        if (runtime.phase === 'RETREAT') {
            routeTarget = getRetreatWaypoint(runtime, flags, ao) || (flags.waitPos || flags.assemblyPos || (ao && ao.centerPos));
        } else {
            routeTarget = route.getRouteTarget(creep, runtime, flags, ao);

            // If attack/AO flag was removed while we were in ENGAGE, fall back to latest reached waypoint
            // (instead of snapping all the way back to W).
            if (runtime.phase === 'STAGE' && !flags.attackFlag) {
                const hold = getRetreatWaypoint(runtime, flags, ao);
                if (hold) routeTarget = hold;
            }
        }
    }


    // AO-bounded target selection
    const dismantleMode = isDismantleMission(mission);

    let target = null;
    let targetDebug = null;
    let engageCtx = null;

    if (runtime.phase === 'ENGAGE') {
        targetDebug = { reason: 'none', counts: {} };

        // Keep existing engage context to detect hostiles / AO context,
        // but allow dismantle missions to override the "what do I focus" target safely.
        engageCtx = engage.getEngageContext(creep, flags, ao, targetDebug);

        if (dismantleMode) {
            target = pickDismantleTarget(creep, ao);
            targetDebug.reason = target ? `dismantle:${target.structureType}` : 'dismantle:none';
        } else {
            target = engageCtx.target;
        }
    }



// --------------------------------------------------
// 🎛 Phase-aware PathFinder callback switching (clean)
// --------------------------------------------------
// We keep travel + combat callbacks injected by tasker, but only activate the combat matrix
// when we're actually fighting in the engage room.
const engageRoomName = resolveEngageRoomName(ao, flags, routeTarget);
const hasCombatThreat = !!(engageCtx && engageCtx.hasHostiles);
const active = selectActiveRoomCallback(runtime, runtime.phase, creep, engageRoomName, hasCombatThreat, dismantleMode);

if (active && active.cb) runtime.roomCallback = active.cb;
else delete runtime.roomCallback;

// Optional debug breadcrumb
const cbDbg = runtime.debug || (runtime.debug = {});
cbDbg.lastRoomCallbackMode = active ? active.mode : 'none';
    // (Micro-step removed) Keeping runtime position history is optional; omitted for now.


    const enableSoloDebug = true;
        //!!(runtime && runtime.debug && runtime.debug.soloPlannerVerbose);

    // 🧠 SOLO PATH PLANNING (pure PF step; goal is decided above)
    // In ENGAGE: goal = tactical anchor (movement position), NOT the shoot/heal target.
    // In other phases: goal = routeTarget from the route planner.
    let moveGoal = routeTarget;
    let moveRange = 1;

    if (runtime.phase === 'ENGAGE') {

        const hasHostiles = !!(engageCtx && engageCtx.hasHostiles);

        // If ENGAGE begins while we're still in the staging/assembly room (no vision / hostiles here),
        // do NOT let tactical anchoring override cross-room travel. Only run combat anchoring once
        // we're inside the AO / attack room.
        const inEngageRoom = !engageRoomName || creep.pos.roomName === engageRoomName;

        if (dismantleMode) {
            // 🧱 Dismantle missions: keep ALL the existing travel/phase/PF goodness,
            // but override ENGAGE movement to approach a structure at range 1.
            if (!inEngageRoom) {
                moveGoal = routeTarget;
                moveRange = 1;
            } else if (target && target.pos) {
                moveGoal = target.pos;
                moveRange = 1;
            } else {
                // No structures left: hold on the AO anchor (or attack flag)
                if (flags.attackPos) moveGoal = flags.attackPos;
                else if (ao && ao.centerPos) moveGoal = ao.centerPos;
                moveRange = 0;
            }
        } else if (hasHostiles && inEngageRoom) {
            // 🔥 Tactical combat movement
            const tactical = soloTactics.decideAnchor(
                creep,
                runtime,
                flags,
                ao,
                target,
                { debug: enableSoloDebug }
            );

            if (tactical && tactical.anchorPos) {
                moveGoal = tactical.anchorPos;
                // Anchor is a specific tile choice → must stand on it
                moveRange = 0;

                const dbg = runtime.debug || (runtime.debug = {});
                dbg.lastAnchor = `${moveGoal.roomName}:${moveGoal.x},${moveGoal.y}`;
                dbg.lastAnchorReason = tactical.reason || null;
            }

        } else if (!inEngageRoom) {
            // Still traveling to the AO / attack room → keep strategic route target (cross-room movement)
            moveGoal = routeTarget;
            moveRange = 1;
        } else {
            // 🏁 No enemies (in AO room) → hold AO strategic anchor
            if (flags.attackPos) {
                moveGoal = flags.attackPos;
            } else if (ao && ao.centerPos) {
                moveGoal = ao.centerPos;
            }

            moveRange = 0;
        }
    }

    const movePlan =
        soloPlanner.plan(
            creep,
            runtime,
            moveGoal,
            enableSoloDebug
                ? { range: moveRange, cacheKey: 'solo', forceRecalc: (runtime.phase === 'ENGAGE'), debug: true }
                : { range: moveRange, cacheKey: 'solo', forceRecalc: (runtime.phase === 'ENGAGE') }
        );

    // Let actionPlan handle attack/heal logic.
    // routeTarget stays the "strategic" destination.
    // movePlan (optional) overrides movement for 1-tick micro.
    let plan;
    if (dismantleMode) {
        // Build a "task" in the same shape as actionPlan output:
        // - DO NOT attach movePlan (soloPlanner output is not duo-style step.dir)
        // - Use movePlan's computed next position as the moveTarget, so role.assault can moveTo it.
        plan = {
            moveTarget: (movePlan && movePlan.moveTarget)
                ? movePlan.moveTarget
                : (moveGoal ? { x: moveGoal.x, y: moveGoal.y, roomName: moveGoal.roomName } : null),
            range: (movePlan && Number.isFinite(movePlan.range)) ? movePlan.range : moveRange,
            actions: []
        };

        // Only dismantle once we are in the engage room and have a valid structure target.
        const inEngageRoom = !engageRoomName || creep.pos.roomName === engageRoomName;
        if (inEngageRoom && target && target.id) {
            plan.actions.push({ action: 'dismantle', targetId: target.id });
        }
    } else {
        // Default assault behaviour (unchanged)
        plan = actionPlan.plan(
            creep,
            runtime,
            target,
            routeTarget,
            movePlan // <-- 5th param
        );
    }

    // ---- Debug logging for oscillation / target changes ----
    const dbg = runtime.debug || (runtime.debug = {});

    const posNow = posKey(creep.pos);
    const routeKey = posKey(routeTarget);
    const targetKey = target ? `${formatPos(target.pos)}(${target.id})` : null;
    const targetReason = targetDebug ? targetDebug.reason : null;
    const targetCounts = targetDebug ? targetDebug.counts : null;
    const anchorKey = moveGoal ? posKey(moveGoal) : null;
    const anchorReason = (runtime.debug && runtime.debug.lastAnchorReason) ? runtime.debug.lastAnchorReason : null;
    const finalMoveKey = plan && plan.moveTarget ? posKey(plan.moveTarget) : null;

    if (dbg.lastPhase && dbg.lastPhase !== runtime.phase) {
        const reason = dbg.lastPhaseReason ? ` reason=${dbg.lastPhaseReason}` : '';
        logSolo(runtime, mission, `phase ${dbg.lastPhase} -> ${runtime.phase}${reason}`);
    }

    if (routeKey !== dbg.lastRouteTarget) {
        logSolo(runtime, mission, `routeTarget ${dbg.lastRouteTarget || 'null'} -> ${routeKey || 'null'}`);
    }

    if (targetKey !== dbg.lastTarget || (targetReason && targetReason !== dbg.lastTargetReason)) {
        const reason = targetReason ? ` reason=${targetReason}` : '';
        const counts = targetCounts
            ? ` counts=H:${targetCounts.hostiles} S:${targetCounts.hostileStructures} AF:${targetCounts.attackFlag} AO:${targetCounts.aoNearby}`
            : '';
        logSolo(runtime, mission, `target ${dbg.lastTarget || 'null'} -> ${targetKey || 'null'}${reason}${counts}`);
    }

    if (anchorKey !== dbg.lastAnchorSelected || (anchorReason && anchorReason !== dbg.lastAnchorSelectedReason)) {
        const reason = anchorReason ? ` reason=${anchorReason}` : '';
        logSolo(runtime, mission, `anchor ${dbg.lastAnchorSelected || 'null'} -> ${anchorKey || 'null'}${reason}`);
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

    if (enableSoloDebug) {
        try {
            const td = runtime && runtime._soloTactics && runtime._soloTactics.debug && runtime._soloTactics.debug.last;
            if (td && td.tick === now) {
                const best = td.best ? `best=${td.best.pos} score=${td.best.score.toFixed(2)} raw=${td.best.raw} dist=${td.best.dist} r=${td.best.r}` : 'best=null';
                const second = td.second ? `second=${td.second.pos} score=${td.second.score.toFixed(2)} raw=${td.second.raw} dist=${td.second.dist} r=${td.second.r}` : 'second=null';
                logSolo(runtime, mission, `tactics focus=${td.focus}(${td.focusReason}) role=${td.role} prefR=${td.prefRange} ${best} ${second}`);
            }
        } catch (e) {
            // ignore debug
        }
    }


    dbg.lastPhase = runtime.phase;
    dbg.lastRouteTarget = routeKey;
    dbg.lastTarget = targetKey;
    dbg.lastTargetReason = targetReason;
    dbg.lastAnchorSelected = anchorKey;
    dbg.lastAnchorSelectedReason = anchorReason;
    dbg.lastMoveTarget = finalMoveKey;
    dbg.lastPos = posNow;
    dbg.lastTick = now;

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
