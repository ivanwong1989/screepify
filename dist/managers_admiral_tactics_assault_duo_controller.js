const memory = require('managers_admiral_tactics_assault_common_memory');
const flagsResolver = require('managers_admiral_tactics_assault_common_flags');
const aoResolver = require('managers_admiral_tactics_assault_common_ao');
const rendezvous = require('managers_admiral_tactics_assault_duo_rendezvous');
const engage = require('managers_admiral_tactics_assault_duo_engage');
const actionPlan = require('managers_admiral_tactics_assault_duo_actionPlan');
const duoPlanner = require('managers_admiral_tactics_assault_duo_duoPlanner_duoPlanner');
const duoTactics = require('managers_admiral_tactics_assault_duo_duoTactics');
const threatEval = require('managers_admiral_tactics_assault_common_threat');
const boostGate = require('managers_admiral_tactics_boostgate_boostGate');

const RETREAT_AT = 0.8;
const REENGAGE_AT = 0.99;
const COHESION_RANGE = 1;


// ---- Assault tuning (optional, safe defaults) ----
// Uses Memory.military.attack (set by assaultTuning(...) in console)
function getAttackTuning() {
    const m = (typeof Memory !== 'undefined' && Memory.military && Memory.military.attack)
        ? Memory.military.attack
        : null;
    return m || {};
}

// Read number with fallback; clamps optional
function tunedNumber(key, fallback, min, max) {
    const t = getAttackTuning();
    const v = t ? t[key] : undefined;
    let n = Number(v);
    if (!Number.isFinite(n)) n = fallback;
    if (Number.isFinite(min)) n = Math.max(min, n);
    if (Number.isFinite(max)) n = Math.min(max, n);
    return n;
}

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


// Rate-limited callback error logging (once per tick per key)
function logCbErrorOnce(runtime, mission, key, message) {
    if (!runtime) return;
    if (!runtime.debug) runtime.debug = {};
    const t = (typeof Game !== 'undefined' && Game && typeof Game.time === 'number') ? Game.time : -1;
    const last = runtime.debug._cbErr || null;
    if (last && last.t === t && last.key === key) return;
    runtime.debug._cbErr = { t, key };
    logDuo(runtime, mission, message);
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
    // ✅ Source of truth: assigned mission binding
    const byMission = inferRoleFromMissionName(creep);
    if (byMission) return byMission;

    // fallback only
    if (creep && creep.memory && creep.memory.assaultRole) return creep.memory.assaultRole;

    return null;
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

    // If still ambiguous, do not reorder here.
    // Caller should pass correct leaderInput/supportInput, and missionName binding is the authority.

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

function getHoldWaypoint(runtime, flags, ao) {
    const waypoints = (flags && flags.waypointPositions) ? flags.waypointPositions : [];
    if (!Array.isArray(waypoints) || waypoints.length === 0) {
        return (flags && (flags.assemblyPos || flags.waitPos)) || (ao && ao.centerPos) || null;
    }

    // waypointIndex is the "next" waypoint we are trying to reach.
    // If the waypoint list shrinks (e.g. A / later W<N> flags removed),
    // clamp to the last existing waypoint so we HOLD at the latest known waypoint
    // instead of snapping all the way back to W/assembly.
    let idx = Number(runtime && runtime.route && runtime.route.waypointIndex);
    if (!Number.isFinite(idx) || idx < 0) idx = 0;
    if (idx >= waypoints.length) idx = waypoints.length - 1;

    return waypoints[idx];
}


function getRetreatWaypoint(runtime, flags, ao) {
    const waypoints = (flags && flags.waypointPositions) ? flags.waypointPositions : [];
    if (!Array.isArray(waypoints) || waypoints.length === 0) return null;

    // waypointIndex is the "next" waypoint we are trying to reach.
    // So the last reached waypoint is waypointIndex - 1 (clamped).
    let idx = Number(runtime && runtime.route && runtime.route.waypointIndex);
    if (!Number.isFinite(idx) || idx <= 0) return waypoints[0];

    idx = Math.min(idx - 1, waypoints.length - 1);
    return waypoints[idx];
}


function getRouteTarget(runtime, flags, ao, hasAttackDirective) {
    if (runtime.phase === 'ASSEMBLE') return flags.assemblyPos || flags.waitPos || (ao && ao.centerPos);

    if (runtime.phase === 'ROUTE') {
        const waypoints = flags.waypointPositions || [];
        let index = Number(runtime.route && runtime.route.waypointIndex);
        if (!Number.isFinite(index) || index < 0) index = 0;

        // If waypoint list has shrunk (e.g. removed higher W<N> or A),
        // clamp to the last waypoint and HOLD there.
        if (index >= waypoints.length && waypoints.length > 0) {
            return getHoldWaypoint(runtime, flags, ao);
        }

        if (waypoints[index]) return waypoints[index];

        // If there is an attack directive, we can proceed to attackPos/center.
        if (hasAttackDirective) return flags.attackPos || (ao && ao.centerPos);

        // Otherwise, hold at the latest waypoint instead of returning to W/assembly.
        return getHoldWaypoint(runtime, flags, ao);
    }

    if (runtime.phase === 'ENGAGE') {
        // If the attack directive disappears mid-run, HOLD at latest waypoint (if any)
        // rather than snapping back to assembly.
        if (!hasAttackDirective) return getHoldWaypoint(runtime, flags, ao);
        return flags.attackPos || (ao && ao.centerPos);
    }

    if (runtime.phase === 'RETREAT') {
        const waypoints = flags.waypointPositions || [];

        if (Array.isArray(waypoints) && waypoints.length > 0) {
            let idx = Number(runtime.route && runtime.route.waypointIndex);

            if (!Number.isFinite(idx) || idx <= 0) {
                // Never reached first waypoint → fall back to first waypoint
                return waypoints[0];
            }

            // Retreat to last reached waypoint
            idx = Math.min(idx - 1, waypoints.length - 1);
            return waypoints[idx];
        }

        // No waypoints defined → fallback to wait/assembly
        return flags.waitPos || flags.assemblyPos || (ao && ao.centerPos);
    }

    return flags.waitPos || (ao && ao.centerPos);
}

function computeRegroup(leader, support, cohesionRange) {
    if (!leader || !support) return false;
    if (leader.room.name !== support.room.name) return true;
    const range = Number.isFinite(cohesionRange) ? cohesionRange : COHESION_RANGE;
    return leader.pos.getRangeTo(support.pos) > range;
}

function handleWipe(runtime, leader, support, now) {
    // ✅ No TTL: we only reset once we've actually progressed (assembled or left ASSEMBLE).
    if (leader || support) {
        if (runtime && runtime.wipe) runtime.wipe.lastFullMissingAt = 0;
        return { reset: false };
    }

    const assembledDone = !!(runtime && runtime.assembled && runtime.assembled.done);
    const progressed = assembledDone || (runtime && runtime.phase && runtime.phase !== 'ASSEMBLE');

    if (progressed) {
        return { reset: true };
    }
    return { reset: false };
}

function shouldExitRetreat(runtime, leader, support, flags, ao) {
    if (!leader || !support) return false;
    if (!shouldReengage(leader) || !shouldReengage(support)) return false;

    // ✅ Exit RETREAT once healed AND back at the retreat destination (latest reached waypoint).
    // This prevents "healed at waypoint but never exits" when waitPos (W) is far away.
    const rp = getRetreatWaypoint(runtime, flags, ao);
    if (rp) {
        return leader.pos.inRangeTo(rp.x, rp.y, 2) && support.pos.inRangeTo(rp.x, rp.y, 2);
    }

    // Fallback: legacy behavior (waitPos / assembly).
    if (!flags.waitPos) return true;
    return leader.pos.inRangeTo(flags.waitPos.x, flags.waitPos.y, 2) &&
           support.pos.inRangeTo(flags.waitPos.x, flags.waitPos.y, 2);
}

function toRoomPos(p) {
    if (!p) return null;
    if (p instanceof RoomPosition) return p;
    return new RoomPosition(p.x, p.y, p.roomName || (p.room && p.room.name));
}


function decideCombatIntent(runtime, leader, support, target, ao) {
    // Default: follow routeTarget behavior handled elsewhere
    if (runtime.phase !== 'ENGAGE') return { mode: 'TRAVEL' };

    // If no target, "hold AO" (stick near attackPos/center)
    if (!target) return { mode: 'HOLD_AO' };

    const hasRanged = leader && leader.getActiveBodyparts(RANGED_ATTACK) > 0;
    const desired = hasRanged ? 3 : 1;

    // If too close to the target, enter basic kite
    const dist = leader ? leader.pos.getRangeTo(target) : 999;
    // dangerRadius: when ranged and target is within this range, we enter KITE
    const dangerRadius = tunedNumber('dangerRadius', 2, 1, 6);
    const tooClose = hasRanged && dist <= dangerRadius;

    if (tooClose) {
        return {
            mode: 'KITE',
            desiredRange: desired + 1
        };
    }

    return {
        mode: 'ENGAGE',
        desiredRange: desired
    };
}




function planForPair(mission, leaderInput, supportInput, context) {
    const runtimeKey = mission && mission.data && mission.data.squadKey ? mission.data.squadKey : mission.name;
    let runtime = memory.getDuoRuntime(runtimeKey);
    // Heartbeat: if mission exists on the board, touch runtime so GC won't delete it
    memory.touchDuoRuntime(runtime, mission, runtimeKey);
    // 🔌 Inject tasker-provided callbacks into duo runtime (STRICT)
    if (context && context.runtime) {
        runtime.travelRoomCallback = (typeof context.runtime.travelRoomCallback === 'function')
            ? context.runtime.travelRoomCallback
            : null;
        runtime.combatRoomCallback = (typeof context.runtime.combatRoomCallback === 'function')
            ? context.runtime.combatRoomCallback
            : null;

        // STRICT: ignore legacy single roomCallback entirely (no silent fallback)
        runtime.roomCallback = null;

        if (typeof context.runtime.roomCallback === 'function') {
            logCbErrorOnce(runtime, mission, 'legacyRoomCallbackIgnored',
                'STRICT: legacy context.runtime.roomCallback was provided but is ignored. Provide travelRoomCallback/combatRoomCallback instead.'
            );
        }
    }
    if (!runtime.debug) runtime.debug = {};
    const flags = flagsResolver.resolveFlags(mission);
    const ao = aoResolver.resolveAO(mission, flags);
    const m = mission;
    const mData = (m && m.data) ? m.data : null;
    const mFlags = (mData && mData.flags) ? mData.flags : null;
    const attackKey = (mFlags && mFlags.attack != null) ? mFlags.attack : null;

    // --- Option A: Only allow ENGAGE targeting if attack directive exists ---
    const hasAttackDirective =
    !!flags.attackPos ||          // resolved attack position
    !!flags.attackFlag;           // resolved attack flag object

    logDuo(runtime, mission,
    'AO/Flag dbg: mission.flags.attack=' + JSON.stringify(attackKey) +
    ' resolvedAttackFlag=' + (flags && flags.attackFlag ? flags.attackFlag.name : 'null') +
    ' attackAoOverride=' + (flags ? flags.attackAoRadiusOverride : 'n/a') +
    ' ao.radius=' + (ao ? ao.radius : 'n/a') +
    ' center=' + formatPos(ao && ao.centerPos ? ao.centerPos : null)
    );
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

    // ====================
    // 🚪 BOOST GATE (Pre-Assembly / Pre-Combat)
    // ====================
    const squadKey = mission && mission.data && mission.data.squadKey;

    // Only run boostGate if squadKey exists (same contract as solo).
    // If boosting is active, boostGate will issue creep.moveTo(...) itself,
    // and we must NOT run assembly/route/engage logic this tick.
    if (squadKey) {
        let leaderOk = true;
        let supportOk = true;

        if (leader) leaderOk = boostGate.runBoostGate(leader, squadKey);
        if (support) supportOk = boostGate.runBoostGate(support, squadKey);

        if (!leaderOk || !supportOk) {
            const dbg = runtime.debug || (runtime.debug = {});
            if (!dbg.lastBoostBlockAt || (now - dbg.lastBoostBlockAt) >= 5) {
                logDuo(runtime, mission,
                    `boostGate blocking; squadKey=${squadKey} ` +
                    `L=${leader ? (leaderOk ? 'ok' : 'block') : 'null'} ` +
                    `S=${support ? (supportOk ? 'ok' : 'block') : 'null'}`
                );
                dbg.lastBoostBlockAt = now;
            }

            // While boosting:
            // - Do NOT let the mission progress phases / waypoints / combat.
            // - Spawn policy: allow spawning only if the pair is incomplete.
            if (runtime && runtime.spawn) {
                runtime.spawn.allow = !(leader && support);
                runtime.spawn.lastAllowAt = now;
            }

            // Keep it in a safe "pre-assembled" phase.
            if (!runtime.assembled || !runtime.assembled.done) {
                runtime.phase = 'ASSEMBLE';
            }

            return {
                leaderTask: null,
                supportTask: null,
                runtime,
                debug: runtime.debug || {}
            };
        }
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
            runtime.phase = (flags.waypointPositions && flags.waypointPositions.length > 0) ? 'ROUTE' : (hasAttackDirective ? 'ENGAGE' : 'ROUTE');
            logDuo(runtime, mission, `assembled=1 at=${now} pos=${formatPos(flags.assemblyPos)} phase=${runtime.phase}`);
        } else {
            runtime.phase = 'ASSEMBLE';
            runtime.spawn.allow = true;
            runtime.spawn.lastAllowAt = now;
        }
    } else {
        runtime.spawn.allow = false;
        if (runtime.phase === 'ASSEMBLE') {
            runtime.phase = (flags.waypointPositions && flags.waypointPositions.length > 0) ? 'ROUTE' : (hasAttackDirective ? 'ENGAGE' : 'ROUTE');
        }
    }

    if (runtime.assembled.done) {
        if (runtime.phase !== 'RETREAT' && (shouldRetreat(leader) || shouldRetreat(support))) {
            runtime.phase = 'RETREAT';
        } else if (runtime.phase === 'RETREAT' && shouldExitRetreat(runtime, leader, support, flags, ao)) {
            runtime.phase = (flags.waypointPositions && flags.waypointPositions.length > 0) ? 'ROUTE' : (hasAttackDirective ? 'ENGAGE' : 'ROUTE');
        }
    }

    const threat = threatEval.evaluateThreat(leader, support);
    // Simplified doctrine:
    // 1) Always stay together (adjacent)
    // 2) If not together, regroup
    // No allowSplit / split-retreat behavior.
    const cohesionRange = COHESION_RANGE;
    let baseRegroup = false;
    if (runtime.assembled.done && (!leader || !support)) {
        runtime.phase = 'RETREAT';
        baseRegroup = false;
    } else {
        baseRegroup = computeRegroup(leader, support, cohesionRange);
    }
    const strictBroken = leader && support && leader.room.name === support.room.name && leader.pos.getRangeTo(support.pos) > 1;
    if (strictBroken) baseRegroup = true;

    if (runtime.assembled.done) {
        if (runtime.phase === 'ROUTE') {
            if (!baseRegroup) {
                advanceWaypoint(runtime, leader, support, flags.waypointPositions || []);
            }
            const index = Number(runtime.route && runtime.route.waypointIndex) || 0;
            if (index >= (flags.waypointPositions || []).length) {
                runtime.phase = hasAttackDirective ? 'ENGAGE' : 'ROUTE';
            }
        }
    }

    if (runtime.phase !== prevPhase) {
        logDuo(runtime, mission, `phase=${prevPhase}->${runtime.phase} leader=${formatCreep(leader)} support=${formatCreep(support)}`);
    }

    const routeTarget = getRouteTarget(runtime, flags, ao, hasAttackDirective);
    const rallyPos = flags.assemblyPos || flags.waitPos || routeTarget;

    const engageActor = leader || support;

    // AO-aware target selection (engage.js now filters by AO)
    const target =
        runtime.phase === 'ENGAGE' && engageActor && hasAttackDirective
            ? engage.selectTarget(engageActor, flags, ao)
            : null;

    // If leader is in immediate melee contact, this is handled by tactics/anchor.

    // Decide combat intent (basic plug, used for logging/telemetry)
    const intent = decideCombatIntent(runtime, leader, support, target, ao);

    // Select planner goal for this tick
    let goalPos = routeTarget;
    let goalRange = 1;

    let tactical = null;
    // If ENGAGE goal is in another room, we are still effectively traveling.
    // Do NOT run tactical anchoring until we're inside the AO/attack room; otherwise it can "hold" in the assembly room.
    const engageInAORoom = (runtime.phase === 'ENGAGE') && leader && (
        (ao && ao.targetRoom && leader.room && leader.room.name === ao.targetRoom) ||
        (flags && flags.attackPos && leader.room && leader.room.name === flags.attackPos.roomName)
    );

    if (runtime.phase === 'ENGAGE' && engageInAORoom && target) {
        // Determine which callback should be active for this tick
        const useCombat = (runtime.phase === 'ENGAGE') && engageInAORoom;

        const activeRoomCallback = useCombat
            ? runtime.combatRoomCallback
            : runtime.travelRoomCallback;

        const tacticalRuntime = Object.assign({}, runtime, {
            roomCallback: activeRoomCallback
        });

        tactical = duoTactics.decideAnchor(
            leader,
            support,
            tacticalRuntime, // 👈 pass correct callback
            flags,
            ao,
            target,
            {
                duoKey: String(runtimeKey),
                holdCenterRange: tunedNumber('holdCenterRange', 1, 0, 3),
                preferRoads: true,
                meleeCommit: !!(leader && leader.getActiveBodyparts(ATTACK) > 0 && leader.getActiveBodyparts(RANGED_ATTACK) <= 0),
                debug: true,
                logDuo: true
            }
        );

        if (tactical && tactical.anchorPos) {
            goalPos = tactical.anchorPos;
            goalRange = Number.isFinite(tactical.range) ? tactical.range : 0;
        } else {
            if (target) {
                goalPos = target.pos;
                goalRange = 1;
            } else if (flags.attackPos) {
                goalPos = flags.attackPos;
                goalRange = 1;
            } else {
                goalPos = routeTarget;
                goalRange = 1;
            }
        }
    }

    const tacticalAnchor = (runtime.phase === 'ENGAGE' && typeof tactical !== 'undefined' && tactical && tactical.anchorPos)
        ? formatPos(tactical.anchorPos)
        : 'n/a';
    const tacticalRange = (runtime.phase === 'ENGAGE' && typeof tactical !== 'undefined' && tactical && Number.isFinite(tactical.range))
        ? tactical.range
        : 'n/a';
    const tacticalReason = (runtime.phase === 'ENGAGE' && typeof tactical !== 'undefined' && tactical && tactical.reason)
        ? tactical.reason
        : 'n/a';
    const tacticalSupportHint = (runtime.phase === 'ENGAGE' && typeof tactical !== 'undefined' && tactical && tactical.supportHintPos)
        ? formatPos(tactical.supportHintPos)
        : 'n/a';
    if (runtime && runtime.debug) {
        runtime.debug.tactical = {
            anchorPos: tacticalAnchor,
            range: tacticalRange,
            reason: tacticalReason,
            supportHintPos: tacticalSupportHint
        };
    }

    // Pass the chosen goal into planner
    const travelSupportMode = ((runtime.phase !== 'ENGAGE') || !engageInAORoom) ? 'trail' : 'auto';
    const leaderMeleeParts = leader ? leader.getActiveBodyparts(ATTACK) : 0;
    const leaderRangedParts = leader ? leader.getActiveBodyparts(RANGED_ATTACK) : 0;
    const leaderPureMelee = leaderMeleeParts > 0 && leaderRangedParts <= 0;
    const leaderMeleePreferred = leaderMeleeParts > 0 && leaderMeleeParts >= leaderRangedParts;
    const supportHardThreatThreshold = leaderPureMelee
        ? tunedNumber('supportHardThreatThresholdPureMelee', 254, 20, 254)
        : (leaderMeleePreferred
            ? tunedNumber('supportHardThreatThresholdMelee', 75, 20, 254)
            : tunedNumber('supportHardThreatThreshold', 40, 20, 254));
    const supportThreatDeltaHard = leaderPureMelee
        ? tunedNumber('supportThreatDeltaHardPureMelee', 254, 0, 254)
        : (leaderMeleePreferred
            ? tunedNumber('supportThreatDeltaHardMelee', 45, 0, 254)
            : tunedNumber('supportThreatDeltaHard', 25, 0, 254));
    const supportUnsafeHardThreshold = leaderPureMelee
        ? tunedNumber('supportUnsafeHardThresholdPureMelee', 254, 20, 254)
        : tunedNumber('supportUnsafeHardThreshold', 60, 20, 254);

    const move = duoPlanner.plan({
        leader,
        support,
        memoryKey: `duo:${runtimeKey}`,
        goal: {
            pos: goalPos,
            type: 'RANGE',
            range: goalRange
        },
        formation: {
            cohesionRange,
            anchor: 'leader',
            supportOffset: 'auto',
            travelSupportMode,
            // Melee leaders need support to tolerate deeper threat tiles so the duo can
            // maintain cohesion while closing into ATTACK range.
            supportHardThreatThreshold,
            supportThreatDeltaHard
        },
        movement: {
            
            // ---- Travel behaviour ----
            usePathCache: (runtime.phase !== 'ENGAGE') || !engageInAORoom,
            pathReuseTicks: 25,
            stallRepathTicks: 2,
            preferRoads: (runtime.phase !== 'ENGAGE') || !engageInAORoom,

            // ---- Combat behaviour ----
            combat: (runtime.phase === 'ENGAGE') && engageInAORoom,
            combatMagnet: (runtime.phase === 'ENGAGE') && engageInAORoom,
            combatFreshPF: (runtime.phase === 'ENGAGE') && engageInAORoom
        },
        runtime: (() => {
            const useCombat = (runtime.phase === 'ENGAGE') && engageInAORoom;

            let selectedCb = null;
            if (useCombat) {
                if (runtime.combatRoomCallback) {
                    selectedCb = runtime.combatRoomCallback;
                } else {
                    logCbErrorOnce(runtime, mission, 'missingCombatRoomCallback',
                        `ERROR: Missing combatRoomCallback in COMBAT mode (phase=ENGAGE in AO). Using null roomCallback. phase=${runtime.phase} aoRoom=${engageInAORoom ? 1 : 0}`
                    );
                    selectedCb = null;
                }
            } else {
                if (runtime.travelRoomCallback) {
                    selectedCb = runtime.travelRoomCallback;
                } else {
                    logCbErrorOnce(runtime, mission, 'missingTravelRoomCallback',
                        `ERROR: Missing travelRoomCallback in TRAVEL mode. Using null roomCallback. phase=${runtime.phase} aoRoom=${engageInAORoom ? 1 : 0}`
                    );
                    selectedCb = null;
                }
            }

            return {
                // STRICT: only the selected callback is used *right now*
                roomCallback: selectedCb,
                phase: runtime.phase,
                supportUnsafeHardThreshold,

                // pass through both explicitly (no fallback chaining)
                travelRoomCallback: runtime.travelRoomCallback,
                combatRoomCallback: runtime.combatRoomCallback,
            };
        })(),


        enemyPos: target ? target.pos : null,

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
        const suppressCombat = runtime.phase === 'RETREAT';
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
        const cohesive = move ? (move.cohesive ? 1 : 0) : (leader && support ? (leader.pos.getRangeTo(support.pos) <= cohesionRange ? 1 : 0) : 0);
        const allowStep = move && move.step && (move.step.leaderDir || move.step.supportDir) ? 1 : 0;
        const mode = move ? move.mode : runtime.phase;
        const hasTargetPos = target ? 1 : 0;
        const hasRouteTarget = routeTarget ? 1 : 0;
        const predictedSeparation = 0;
        const suppressCombat = (runtime.phase === 'ASSEMBLE' || runtime.phase === 'ROUTE' || runtime.phase === 'RETREAT') ? 1 : 0;
        const lfat = leader ? leader.fatigue || 0 : 0;
        const sfat = support ? support.fatigue || 0 : 0;
        const rej = (move && move.debug && move.debug.rejects)
                    ? JSON.stringify(move.debug.rejects)
                    : '';
        const bh = (move && move.debug && move.debug.border)
                    ? JSON.stringify(move.debug.border)
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
        const goalLabel = goalPos ? `${goalPos.roomName}:${goalPos.x},${goalPos.y} r=${goalRange}` : 'none';
        const intentLabel = intent ? (intent.mode || 'none') : 'none';
        logDuo(
            runtime,
            mission,
            `phase=${runtime.phase} mode=${mode} allowStep=${allowStep} assembled=${runtime.assembled.done ? 1 : 0} spawnAllow=${runtime.spawn.allow ? 1 : 0} cohesive=${cohesive} dist=${dist} regroup=${runtime.regroup ? 1 : 0} hasTargetPos=${hasTargetPos} hasRouteTarget=${hasRouteTarget} predSep=${predictedSeparation} suppress=${suppressCombat} Lfat=${lfat} Sfat=${sfat} Lnext=${formatPos(leaderNext)} Snext=${formatPos(supportNext)} spin=${spinCount} rally=${formatPos(rallyPos)} routeTarget=${formatPos(routeTarget)} goal=${goalLabel} intent=${intentLabel} tactical=${tacticalAnchor} tRange=${tacticalRange} tReason=${tacticalReason} tHint=${tacticalSupportHint} meleePref=${leaderMeleePreferred ? 1 : 0} pureMelee=${leaderPureMelee ? 1 : 0} sHard=${supportHardThreatThreshold} sDelta=${supportThreatDeltaHard} sUnsafe=${supportUnsafeHardThreshold} waypoint=${waypointIndex}/${waypoints.length} leader=${formatCreep(leader)} support=${formatCreep(support)} target=${targetLabel} rej=${rej} bh=${bh} reason=${reason} who=${who}`
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
