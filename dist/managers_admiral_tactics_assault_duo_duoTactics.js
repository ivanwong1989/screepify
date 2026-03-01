// managers_admiral_tactics_assault_duo_duoTactics.js
//
// DUO tactical anchor selection for ENGAGE phase.
// - Does NOT issue attacks/heals. Only decides "where should we stand" (anchorPos).
// - Uses assault combatMatrix costs (danger heat + base obstacles) to rank candidate tiles.
// - Keeps logic lightweight: sample tiles around the current target (or AO center) and pick best.
// - Controller owns phase logic (RENDEZVOUS/STAGE/RETREAT/etc).
//
// Export:
//   decideAnchor(leader, support, runtime, flags, ao, target, opts?)
//     -> { anchorPos, range, reason, supportHintPos?, debug? }
//
// Notes:
// - anchorPos is movement anchor, NOT the "thing to shoot/heal".
// - target is still selected by engage.selectTarget() (creep/structure/etc).

const { makeAssaultCombatRoomCallback } = require('managers_admiral_tactics_assault_common_combatMatrix');
const { evaluateThreat } = require('managers_admiral_tactics_assault_common_threat');

function toRoomPos(p) {
    if (!p) return null;
    if (p instanceof RoomPosition) return p;
    if (p.pos) p = p.pos;
    const roomName = p.roomName || (p.room && p.room.name);
    if (roomName == null || p.x == null || p.y == null) return null;
    return new RoomPosition(p.x, p.y, roomName);
}

function clampStep(n) {
    if (!Number.isFinite(n)) return 0;
    if (n > 1) return 1;
    if (n < -1) return -1;
    return n;
}

function computeDuoHealPerTick(leader, support) {
    function healParts(creep) {
        if (!creep) return 0;
        let count = 0;
        for (const p of creep.body) {
            if (p.type === HEAL && p.hits > 0) count++;
        }
        return count;
    }

    const leaderHeal = healParts(leader) * 12;
    const supportHeal = healParts(support) * 12;

    // Assume support ranged-heals leader (most common case)
    return leaderHeal + supportHeal;
}


function getCachedEnemyLastPos(target) {
    // Prefer combatMatrix cache if available; otherwise use our local duoTactics cache.
    if (!target || !target.id) return null;
    const g = global || {};
    const cm = g._enemyLastPos;
    if (cm && typeof cm === 'object' && cm[target.id]) return cm[target.id];
    const local = g._duoEnemyLastPos;
    if (local && typeof local === 'object' && local[target.id]) return local[target.id];
    return null;
}

function setCachedEnemyLastPos(target) {
    if (!target || !target.id || !target.pos) return;
    const g = global || {};
    if (!g._duoEnemyLastPos || typeof g._duoEnemyLastPos !== 'object') g._duoEnemyLastPos = {};
    g._duoEnemyLastPos[target.id] = {
        x: target.pos.x,
        y: target.pos.y,
        roomName: target.pos.roomName,
        t: (typeof Game !== 'undefined' && Game.time != null) ? Game.time : 0
    };
}


function getDuoKey(leader, runtime, opts) {
    // Stable-ish key for per-duo tactical caches.
    // Prefer explicit opts.duoKey; otherwise fall back to mission/leader identifiers.
    opts = opts || {};
    return opts.duoKey
        || (runtime && (runtime.name || runtime.missionName))
        || (leader && leader.memory && (leader.memory.missionName || leader.memory.mission))
        || (leader && leader.name)
        || 'duo';
}

function getCachedDuoLastPos(duoKey) {
    const g = global || {};
    const map = g._duoTacticsLastTargetPos;
    if (!map || typeof map !== 'object') return null;
    return map[duoKey] || null;
}

function setCachedDuoLastPos(duoKey, pos) {
    if (!duoKey || !pos) return;
    const g = global || {};
    if (!g._duoTacticsLastTargetPos || typeof g._duoTacticsLastTargetPos !== 'object') {
        g._duoTacticsLastTargetPos = {};
    }
    g._duoTacticsLastTargetPos[duoKey] = { x: pos.x, y: pos.y, roomName: pos.roomName, t: nowTick() };
}

function getEnemyLastVector(target, lastPos) {
    // Returns {dx, dy} in [-1..1], or null if unavailable.
    if (!target || !target.pos || !lastPos) return null;
    if (lastPos.roomName !== target.pos.roomName) return null;
    const dx = clampStep(target.pos.x - lastPos.x);
    const dy = clampStep(target.pos.y - lastPos.y);
    if (dx === 0 && dy === 0) return null; // stationary / unknown intent
    return { dx, dy };
}


function inAO(pos, ao) {
    if (!ao || !ao.centerPos) return true;
    const radius = Number(ao.radius) || 0;
    if (radius <= 0) return true;
    const c = toRoomPos(ao.centerPos);
    if (!c || !pos) return true;
    if (pos.roomName !== c.roomName) return false;
    return c.getRangeTo(pos) <= radius;
}

function isBorder(x, y) {
    return x === 0 || x === 49 || y === 0 || y === 49;
}


function hasPart(creep, partType) {
    if (!creep || !creep.body) return false;
    for (const p of creep.body) {
        if (p && p.type === partType && p.hits > 0) return true;
    }
    return false;
}

function isMobileEnemy(target) {
    // Best-effort: only creeps can move. Structures are immobile.
    if (!target) return false;
    if (typeof Creep !== 'undefined' && target instanceof Creep) return target.getActiveBodyparts(MOVE) > 0;
    // Some wrappers may pass plain objects; detect creep-ish shape.
    if (target.body && Array.isArray(target.body)) {
        // body entries are {type, hits}
        for (const p of target.body) {
            if (p && p.type === MOVE && (p.hits == null || p.hits > 0)) return true;
        }
        return false;
    }
    return false;
}

function getRoleRanges(creep) {
    const ranged = hasPart(creep, RANGED_ATTACK);
    const melee = hasPart(creep, ATTACK);

    // Strict assault behavior:
    // Ranged: always strive for range 3 (no drifting into range 2).
    // Melee: always strive for range 1.
    // NOTE: allow max=4 so the anchor selector can choose a safe buffer ring when
    // simultaneous movement could otherwise drop us to range 2.
    if (ranged) return { min: 3, pref: 3, max: 4, style: 'ranged' };
    if (melee) return { min: 1, pref: 1, max: 1, style: 'melee' };

    // Fallback behavior (non-combat body)
    return { min: 1, pref: 1, max: 1, style: 'worker' };
}

function ensureRuntime(runtime) {
    if (!runtime) return {};
    if (!runtime._duoTactics || typeof runtime._duoTactics !== 'object') runtime._duoTactics = {};
    return runtime._duoTactics;
}

function nowTick() {
    return (typeof Game !== 'undefined' && Game.time != null) ? Game.time : 0;
}


function getDuoDanceState(duoKey) {
    if (!duoKey) return null;
    const g = global || {};
    if (!g._duoDance || typeof g._duoDance !== 'object') g._duoDance = {};
    if (!g._duoDance[duoKey] || typeof g._duoDance[duoKey] !== 'object') {
        g._duoDance[duoKey] = { lastRange: null, lastSign: 0, flips: 0, lastFlipTick: 0, aggressiveUntil: 0 };
    }
    return g._duoDance[duoKey];
}

// Detect "back-and-forth dance" where range oscillates (e.g. 3<->4 or 4<->5) repeatedly.
// If we see >=2 direction flips within a short window, enter an aggressive mode briefly.
// This is intentionally cheap and local (no full prediction): it's just to break stalemates.
// If we see >=2 direction flips within a short window, enter an aggressive mode briefly.
// This is intentionally cheap and local (no full prediction): it's just to break stalemates.
function updateDanceAggro(duoKey, leaderPos, enemyPos, opts) {
    if (!duoKey || !leaderPos || !enemyPos) return false;

    const st = getDuoDanceState(duoKey);
    if (!st) return false;

    const now = nowTick();
    const windowTicks = (opts && Number.isFinite(opts.danceWindowTicks)) ? Math.max(2, Math.floor(opts.danceWindowTicks)) : 8;
    const aggroTicks = (opts && Number.isFinite(opts.danceAggroTicks)) ? Math.max(2, Math.floor(opts.danceAggroTicks)) : 6;
    const flipsToAggro = (opts && Number.isFinite(opts.danceFlipsToAggro)) ? Math.max(1, Math.floor(opts.danceFlipsToAggro)) : 2;

    // Prune old flip streak
    if (st.lastFlipTick && (now - st.lastFlipTick) > windowTicks) {
        st.flips = 0;
        st.lastSign = 0;
    }

    const r = leaderPos.getRangeTo(enemyPos);

    if (Number.isFinite(st.lastRange)) {
        const delta = r - st.lastRange;

        // Only treat meaningful oscillations (±1). Big jumps are likely pathing/LoS breaks.
        const sign = (delta > 0) ? 1 : (delta < 0 ? -1 : 0);

        if (sign !== 0) {
            if (st.lastSign !== 0 && sign !== st.lastSign) {
                st.flips += 1;
                st.lastFlipTick = now;
            }
            st.lastSign = sign;
        }
    }

    st.lastRange = r;

    if (st.flips >= flipsToAggro) {
        st.aggressiveUntil = now + aggroTicks;
        st.flips = 0; // consume the trigger so we don't keep re-triggering every tick
        st.lastSign = 0;
    }

    return (st.aggressiveUntil && now < st.aggressiveUntil);
}

function logDuo(runtime, message) {
    if (!global || typeof global.debug !== 'function') return;
    global.debug('admiral.assault.duo', `[assault.duo] ${message}`);

    if (runtime && runtime.debug) {
        const now = nowTick();
        if (runtime.debug.lastLogTick === now && runtime.debug.lastLog === message) return;
        runtime.debug.lastLogTick = now;
        runtime.debug.lastLog = message;
    }
}

function scoreTile(params) {
    // Lower is better.
    // This is a *weighted* scoring function so caller can tune behavior without changing code.
    const {
        cost, // 0..254 from combat matrix (includes base+danger)
        distFromCreep,
        rangeToTarget,
        prefRange,
        minRange,
        maxRange,
        border,
        onFriendlyRampart,
        onPublicRampart,
        // Optional: neighborhood average danger/terrain cost (0..254)
        neighborhoodCost,
        // Optional: explicit "simultaneous move" close-risk penalty (already computed by caller)
        closeRiskPenalty,
        // Optional weights override
        weights
    } = params;

    // Hard constraints:
    if (rangeToTarget < minRange || rangeToTarget > maxRange) return Infinity;
    if (!Number.isFinite(cost)) return Infinity;

    const w = weights || {};

    const wCost = Number.isFinite(w.cost) ? w.cost : 1.0;
    // Range penalties:
    // - Under-range (closer than pref) is usually OK-ish (esp. for ranged kiting / stepping in).
    // - Over-range (too far to engage) must be punished HARD, otherwise we camp out of attack range.
    // Back-compat: if caller supplies weights.range, treat it as both under/over.
    const wRangeUnder = Number.isFinite(w.rangeUnder)
        ? w.rangeUnder
        : (Number.isFinite(w.range) ? w.range : 12);
    const wRangeOver = Number.isFinite(w.rangeOver)
        ? w.rangeOver
        : (Number.isFinite(w.range) ? w.range : 80);
    const wDist = Number.isFinite(w.dist) ? w.dist : 2.5;
    const wBorder = Number.isFinite(w.border) ? w.border : 25;
    const wFriendlyRampart = Number.isFinite(w.friendlyRampart) ? w.friendlyRampart : -8;
    const wPublicRampart = Number.isFinite(w.publicRampart) ? w.publicRampart : -3;
    const wNeighborhood = Number.isFinite(w.neighborhood) ? w.neighborhood : 0.20;

    // Base: danger+terrain
    let score = cost * wCost;

    // Prefer being at preferred range (e.g. range=3 for ranged), but allow slack via min/max range.
    // Asymmetric penalty: too-far-to-engage gets punished much harder than too-close.
    if (rangeToTarget > prefRange) {
        score += (rangeToTarget - prefRange) * wRangeOver;
    } else if (rangeToTarget < prefRange) {
        score += (prefRange - rangeToTarget) * wRangeUnder;
    }

    // Prefer closer-to-reach anchors, but not overly (danger should dominate)
    score += distFromCreep * wDist;

    // Neighborhood stability: avoid "cheap tile surrounded by lava"
    if (Number.isFinite(neighborhoodCost)) {
        score += neighborhoodCost * wNeighborhood;
    }

    // Avoid borders/exits slightly (your matrix already adds borderCost; this is an extra nudge)
    if (border) score += wBorder;

    // Prefer rampart tiles a bit (bunkering), but keep it mild.
    if (onFriendlyRampart) score += wFriendlyRampart;
    if (onPublicRampart) score += wPublicRampart;

    if (Number.isFinite(closeRiskPenalty) && closeRiskPenalty > 0) {
        score += closeRiskPenalty;
    }

    return score;
}


function rampartStatus(room, x, y) {
    // Fast-ish: only check structures when candidate survived cost checks.
    // Returns { friendly:boolean, pub:boolean }
    if (!room) return { friendly: false, pub: false };
    const structures = room.lookForAt(LOOK_STRUCTURES, x, y);
    if (!structures || structures.length === 0) return { friendly: false, pub: false };

    for (const s of structures) {
        if (s.structureType !== STRUCTURE_RAMPART) continue;
        if (s.my) return { friendly: true, pub: false };
        if (s.isPublic) return { friendly: false, pub: true };
    }
    return { friendly: false, pub: false };
}

function isWalkableForSupport(room, x, y, costs) {
    if (!room) return false;
    if (isBorder(x, y)) return false;
    const c = costs ? costs.get(x, y) : 255;
    if (c === 255) return false;
    const t = room.getTerrain();
    return (t.get(x, y) !== TERRAIN_MASK_WALL);
}

function chooseSupportAdjacency(leaderPos, support, costs, ao, opts) {
    if (!leaderPos || !support || !support.pos || !support.room) return null;
    const room = support.room;
    if (leaderPos.roomName !== room.name) return null;

    const requireInAO = (opts && opts.requireSupportInAO != null) ? !!opts.requireSupportInAO : true;

    let best = null;
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const x = leaderPos.x + dx;
            const y = leaderPos.y + dy;
            if (x < 0 || x > 49 || y < 0 || y > 49) continue;
            if (!isWalkableForSupport(room, x, y, costs)) continue;
            const p = new RoomPosition(x, y, room.name);
            if (requireInAO && !inAO(p, ao)) continue;

            const dist = support.pos.getRangeTo(p);
            const cost = costs ? costs.get(x, y) : 254;
            const score = (Number.isFinite(cost) ? cost : 254) + (dist * 3);
            if (!best || score < best.score) {
                best = { x, y, score };
            }
        }
    }
    return best ? new RoomPosition(best.x, best.y, room.name) : null;
}


// --- Reachability guard ---
// The tile scorer is geometry + cost based; it doesn't ensure the anchor is actually reachable without
// "routing around" an obstacle island. When a candidate is topologically disconnected (wall/structure island),
// move() will typically route toward the target instead, causing unwanted "move in" toward the enemy.
// We fix this by validating reachability for the best few candidates with a cheap, single-room PF probe.
function isReachableAnchor(fromPos, toPos, costs, rangeRef, safeMinRange, opts) {
    if (!fromPos || !toPos) return false;
    if (fromPos.roomName !== toPos.roomName) return false;
    if (fromPos.x === toPos.x && fromPos.y === toPos.y) return true;

    const maxOps = (opts && Number.isFinite(opts.reachMaxOps)) ? Math.max(200, Math.floor(opts.reachMaxOps)) : 900;
    const maxPathLen = (opts && Number.isFinite(opts.reachMaxPathLen)) ? Math.max(1, Math.floor(opts.reachMaxPathLen)) : 12;
    const checkSteps = (opts && Number.isFinite(opts.reachCheckSteps)) ? Math.max(1, Math.floor(opts.reachCheckSteps)) : 3;

    const rc = (roomName) => {
        if (roomName !== fromPos.roomName) return false;
        return costs;
    };

    let res;
    try {
        res = PathFinder.search(
            fromPos,
            { pos: toPos, range: 0 },
            {
                roomCallback: rc,
                maxRooms: 1,
                maxOps,
                heuristicWeight: 1.2
            }
        );
    } catch (e) {
        return false;
    }

    if (!res || res.incomplete) return false;
    const path = res.path || [];
    if (path.length === 0) return true; // already at goal / or adjacent with range=0 goal satisfied

    if (path.length > maxPathLen) return false;

    // Safety: don't accept a "reachable" anchor if the first few steps force us inside our safe min range.
    if (rangeRef && Number.isFinite(safeMinRange) && safeMinRange > 0) {
        const n = Math.min(checkSteps, path.length);
        for (let i = 0; i < n; i++) {
            const step = path[i];
            if (!step) continue;
            const r = step.getRangeTo(rangeRef);
            if (r < safeMinRange) return false;
        }
    }

    return true;
}

/**
 * Decide the movement anchor for ENGAGE.
 */

function isHarmlessEnemy(target) {
    if (!target || !target.body) return true;
    for (const p of target.body) {
        if (!p || p.hits <= 0) continue;
        if (p.type === ATTACK || p.type === RANGED_ATTACK) {
            return false;
        }
    }
    return true;
}

function decideAnchor(leader, support, runtime, flags, ao, target, opts) {
    opts = opts || {};
    if (!leader || !leader.pos || !leader.room) {
        return { anchorPos: null, range: 0, reason: 'no-creep' };
    }

    const rt = ensureRuntime(runtime);
    const duoKey = getDuoKey(leader, runtime, opts);
    const dbg = opts.debug ? (rt.debug || (rt.debug = {})) : null;
    const logEnabled = (opts.logDuo != null) ? !!opts.logDuo : !!opts.debug;

    // Choose "focus" position to anchor around (usually target; else AO center; else attackPos)
    const targetPos = toRoomPos(target);
    const centerPos = toRoomPos(ao && ao.centerPos);
    const attackPos = toRoomPos(flags && flags.attackPos);

    let focus = null;
    let focusReason = 'none';
    if (targetPos && targetPos.roomName === leader.room.name && inAO(targetPos, ao)) {
        focus = targetPos;
        focusReason = 'target';
    } else if (attackPos && attackPos.roomName === leader.room.name && inAO(attackPos, ao)) {
        focus = attackPos;
        focusReason = 'attackPos';
    } else if (centerPos && centerPos.roomName === leader.room.name) {
        focus = centerPos;
        focusReason = 'ao.centerPos';
    } else {
        focus = leader.pos;
        focusReason = 'self';
    }

    if (logEnabled) {
        logDuo(runtime, `focus=${focus.roomName}:${focus.x},${focus.y} reason=${focusReason}`);
    }

    // If no visible room / cross-room focus, just hold route-level behavior.
    if (!focus || focus.roomName !== leader.room.name) {
        if (logEnabled) {
            logDuo(runtime, `fallback=no-focus leaderRoom=${leader.room.name}`);
        }
        return { anchorPos: null, range: 0, reason: 'no-focus' };
    }

    const rr = getRoleRanges(leader);

    let canOutHeal = false;
    let pushAggro = false;

    if (target && leader.room) {
        const threat = evaluateThreat(leader, support);
        const ourHeal = computeDuoHealPerTick(leader, support);

        if (threat.totalDpsIn3 > 0 && ourHeal >= threat.totalDpsIn3) {
            canOutHeal = true;
            pushAggro = true;
        }

        if (dbg) {
            dbg.threat = {
                ourHeal,
                enemyDps: threat ? threat.totalDps : null,
                pushAggro
            };
        }
    }

    // Enemy position (same room only). We keep this for a few tile-level heuristics,
    // but we intentionally do NOT run a separate "closing vector" heuristic here.
    // The combat matrix / aura threshold is the source of truth for kiting/closing behavior.
    const enemyPos = (targetPos && targetPos.roomName === leader.room.name)
        ? targetPos
        : ((target && target.pos && target.pos.roomName === leader.room.name) ? target.pos : null);

    // Build/get combat cost matrix for this room.
    const roomCallback = makeAssaultCombatRoomCallback({
        avoidBorders: true,
        borderCost: 10,
        considerCreeps: false
    });

    const costs = roomCallback(leader.room.name);
    // If matrix is unavailable, degrade to a simple "stand on focus (or near it)".
    if (!costs) {
        if (logEnabled) {
            logDuo(runtime, `fallback=no-matrix focus=${focus.roomName}:${focus.x},${focus.y}`);
        }
        return {
            anchorPos: focus,
            range: 0,
            reason: `fallback:no-matrix:${focusReason}`
        };
    }

    // === Aura-based kiting heuristic (tile-level) ===
    // If our *current tile* is inside the combatMatrix predictive aura / danger band (e.g. +20),
    // we should prefer kiting outward (favor r>=4 for ranged) rather than closing to r=3.
    // If not inside that aura, we should close to r=3 so we can actually shoot.
    const kiteCostThreshold = Number.isFinite(opts.kiteCostThreshold) ? opts.kiteCostThreshold : 20;
    const myTileCostRaw = costs.get(leader.pos.x, leader.pos.y);
    const myTileCost = (myTileCostRaw === 255) ? 254 : myTileCostRaw;
    const kiteLikely = (rr.style === 'ranged') && !!(targetPos && targetPos.roomName === leader.room.name) && (myTileCost >= kiteCostThreshold);

    // Candidate enumeration (single pass):
    // - Sample all tiles in a chebyshev square around focus with a configurable search radius.
    // - Score each candidate using combat matrix danger + weighted preferences (range, travel, border, rampart, neighborhood).
    //
    // Why: pathing already avoids danger; anchor selection must ALSO be danger-aware.
    //
    // Tuning knobs:
    // - opts.searchRadius: how far from focus we consider (default 10)
    // - opts.rangeSlack: allowed deviation from preferred range to target (default: ranged 0, melee 1, worker 0)
    // - opts.weights: { cost, rangeUnder, rangeOver, dist, border, friendlyRampart, publicRampart, neighborhood }
    const weights = opts.weights || {};

// Reachability / geometry constraints:
// - Prevent "teleporting" anchors that require flipping to the far side of the enemy in one hop.
// - Keep anchors within a short horizon so ENGAGE behaves like a near-term tactical choice.
//
// Tuning:
// - opts.maxAnchorDist (default 6): reject anchors farther than this (range from leader).
// - opts.coneCos (default 0.20): keep anchors roughly on our side of the enemy.
//   0.0 = 90° half-angle (very wide), 0.5 ≈ 60°, 0.707 ≈ 45°.
// - opts.disableCone (default false): set true to turn off cone filtering.
const maxAnchorDist = Number.isFinite(opts.maxAnchorDist) ? Math.max(1, Math.floor(opts.maxAnchorDist)) : 6;
const coneCos = Number.isFinite(opts.coneCos) ? Math.max(0, Math.min(0.95, opts.coneCos)) : 0.20;
const disableCone = !!opts.disableCone;

    const defaultSlack =
        (rr.style === 'ranged') ? 0 :
        (rr.style === 'melee') ? 1 :
        0;

    const slack = Number.isFinite(opts.rangeSlack) ? Math.max(0, Math.floor(opts.rangeSlack)) : defaultSlack;

    const rangeHasTarget = !!(targetPos && targetPos.roomName === leader.room.name);
    const rangeRef = rangeHasTarget ? targetPos : focus;

    // Range policy (simple):
    // - Prefer rr.pref (r=3 for ranged)
    // - Allow rr.min..rr.max (ranged: 3..4), so we can pick a buffer ring when simultaneous movement could drop us to r=2.
    // - Rely on the combat matrix's predictive overlay to naturally push us outward when the enemy advances.
    
    // --- Harmless enemy override ---
    let harmlessOverrideApplied = false;
    if (rr.style === 'ranged' && rangeHasTarget && isHarmlessEnemy(target)) {
        harmlessOverrideApplied = true;
    }

    const prefRange = rangeHasTarget ? rr.pref : 0;
  
    let minRange = rangeHasTarget ? Math.max(0, rr.min - slack) : 0;
    let maxRange = rangeHasTarget ? Math.min(10, rr.max + slack) : 50;

    if (harmlessOverrideApplied) {
        minRange = 2;
        maxRange = 3;
    }

    // === Anti-stalemate "dance" detector ===
    // Problem: we can get stuck hovering at r=4 while the enemy also backs away, creating a no-contact loop.
    // Fix: detect a short-range oscillation (range flips direction repeatedly), then briefly prefer closing to r=3/2.
    //
    // Tunables:
    // - opts.danceWindowTicks (default 8): how long to consider flips
    // - opts.danceAggroTicks  (default 6): how long we stay aggressive after trigger
    // - opts.danceFlipsToAggro (default 2): how many direction flips to trigger
    const danceAggro = (!harmlessOverrideApplied
        && rr.style === 'ranged'
        && rangeHasTarget
        && enemyPos
        && target
        && isMobileEnemy(target)
        )
            ? updateDanceAggro(duoKey, leader.pos, enemyPos, opts)
            : false;

    const danceState = getDuoDanceState(duoKey);
    const danceFlips = (danceState && Number.isFinite(danceState.flips)) ? danceState.flips : 0;


    if (danceAggro) {
        // Force engagement band for a short burst.
        minRange = 2;
        maxRange = 3;
    }

    // --- Dance aggro override ---
    // If both sides are range-dancing (3<->4 etc), stop being polite and step in for the kill briefly.
    // This override is temporary and only applies to ranged vs mobile targets.
    if (danceAggro) {
        minRange = 2;
        maxRange = 3;
    }

    // This part is for if we calculated we will outheal enemy's damage
    if (pushAggro && rr.style === 'ranged') {
        minRange = 2;
        maxRange = 2;
    }


    // Search radius: bigger than maxRange so we can actually find candidates when slack>0.
    let searchRadius = Number.isFinite(opts.searchRadius) ? Math.max(1, Math.floor(opts.searchRadius)) : 10;
    searchRadius = Math.max(searchRadius, maxRange + 1);

    // If AO radius is set, don't waste CPU searching beyond it (within same room).
    const aoRadius = (ao && ao.centerPos && ao.centerPos.roomName === leader.room.name) ? (Number(ao.radius) || 0) : 0;
    if (aoRadius > 0) searchRadius = Math.min(searchRadius, aoRadius);

    const minX = Math.max(0, focus.x - searchRadius);
    const maxX = Math.min(49, focus.x + searchRadius);
    const minY = Math.max(0, focus.y - searchRadius);
    const maxY = Math.min(49, focus.y + searchRadius);

    let best = null;
    let second = null;
    const topK = Number.isFinite(opts.topK) ? Math.max(3, Math.floor(opts.topK)) : 10;
    const topCandidates = [];

    const stats = {
        total: 0,
        inAO: 0,
        costOk: 0,
        rangeOk: 0,
        supportOk: 0,
        rejAO: 0,
        rejBlocked: 0,
        rejRangeUnder: 0,
        rejRangeOver: 0,
        rejNoSupport: 0,
        closeGate: 0,
        bestByRange: {},
        rejTooFar: 0,
        rejCone: 0,
        rejUnreachable: 0,
    };

    // Stickiness: if it's our current tile, reduce score slightly so we don't jitter.
    const biasStickiness = Number.isFinite(opts.stickiness) ? opts.stickiness : 0.6;

    function neighborhoodAvgCost(x, y) {
        // Average cost of 8 neighbors (ignores 255 blocks). Helps avoid "one cheap tile in a lava field".
        let sum = 0;
        let n = 0;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;
                const c = costs.get(nx, ny);
                if (c === 255) continue;
                sum += c;
                n += 1;
            }
        }
        return n > 0 ? (sum / n) : costSafeFallback(x, y);
    }

    function costSafeFallback(x, y) {
        const c = costs.get(x, y);
        return (c === 255) ? 254 : c;
    }

    for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
            stats.total += 1;
            const p = new RoomPosition(x, y, leader.room.name);

            if (!inAO(p, ao)) {
                stats.rejAO += 1;
                continue;
            }
            stats.inAO += 1;

            const tileCost = costs.get(x, y);
            if (tileCost === 255) {
                stats.rejBlocked += 1;
                continue;
            }
            stats.costOk += 1;

            // Range reference is decided once above (target when available; else focus).
            const rangeToTarget = rangeRef.getRangeTo(p);
            if (rangeToTarget < minRange) {
                stats.rejRangeUnder += 1;
                continue;
            }
            if (rangeToTarget > maxRange) {
                stats.rejRangeOver += 1;
                continue;
            }
            stats.rangeOk += 1;

            const distFromCreep = leader.pos.getRangeTo(p);

// Short-horizon reachability: don't pick anchors that are too far to realize soon.
if (distFromCreep > maxAnchorDist) {
    stats.rejTooFar += 1;
    continue;
}

// "Same-side" cone filter:
// Reject candidates that are on the far side of the enemy relative to our current approach vector,
// since reaching them typically requires passing close to/through the enemy.
if (!disableCone && rangeHasTarget && targetPos) {
    const ax = leader.pos.x - targetPos.x;
    const ay = leader.pos.y - targetPos.y;
    const bx = x - targetPos.x;
    const by = y - targetPos.y;

    const dot = ax * bx + ay * by;
    if (dot <= 0) {
        stats.rejCone += 1;
        continue; // behind enemy
    }

    const a2 = ax * ax + ay * ay;
    const b2 = bx * bx + by * by;
    // If vectors are degenerate (standing on target or candidate at target), skip cone tightening.
    if (a2 > 0 && b2 > 0) {
        const cos2 = coneCos * coneCos;
        if ((dot * dot) < (a2 * b2 * cos2)) {
            stats.rejCone += 1;
            continue;
        }
    }
}

            // Rampart preference
            const rs = rampartStatus(leader.room, x, y);

            // Simultaneous-move safety:
            // If the enemy is closing overall, then standing at r=3 is unsafe (they can step in and
            // resolution puts us at r=2). In that case, enforce a buffer ring (r>=4), which becomes r=3 worst-case.
            // We detect "closing" primarily by whether enemy got closer to leader since last tick; if that data
            // is unavailable, fall back to a directional vector test toward leader.
            let closeRiskPenalty = 0;
            if (rr.style === 'ranged' && rangeHasTarget && enemyPos) {
                // Why close-gate can be 0 even when we "slip to r=2":
                // - directional closing signal can be missing (no lastPos / stationary / sideways)
                // - even without "closing", a mobile enemy can step-in on the same tick we move,
                //   turning our r=3 anchor into effective r=2.
                //
                // So: if the target is a *mobile creep*, treat r=3 as inherently risky and prefer r>=4.
                // You can disable this conservatism by setting opts.allowRange3VsMobile=true.
                const allowRange3VsMobile = !!(opts && opts.allowRange3VsMobile);
                const shouldGate = (rangeToTarget < 4) && kiteLikely && !danceAggro;

                if (shouldGate) {
                    // Huge penalty (acts like a gate unless there are literally no options)
                    const wg = (weights && Number.isFinite(weights.closeGate)) ? weights.closeGate : 5000;
                    closeRiskPenalty += wg;
                    stats.closeGate += 1;
                }
            }
            let score = scoreTile({
                cost: tileCost,
                distFromCreep,
                rangeToTarget,
                prefRange,
                minRange,
                maxRange,
                border: isBorder(x, y),
                onFriendlyRampart: rs.friendly,
                onPublicRampart: rs.pub,
                neighborhoodCost: neighborhoodAvgCost(x, y),
                closeRiskPenalty,
                weights
            });

            // Stickiness: if it's our current tile, reduce score slightly so we don't jitter.
            if (leader.pos.x === x && leader.pos.y === y) {
                score *= biasStickiness;
            }

            const leaderPos = p;
            const supportHintPos = chooseSupportAdjacency(leaderPos, support, costs, ao, opts);
            if (!supportHintPos) {
                stats.rejNoSupport += 1;
                continue;
            }
            stats.supportOk += 1;

            const rec = { x, y, score, tileCost, distFromCreep, rangeToTarget, rampart: rs };
            rec.supportHintPos = supportHintPos;


// Keep a small pool of best candidates so we can validate reachability against obstacle islands.
topCandidates.push(rec);
if (topCandidates.length > topK) {
    // Remove worst (linear scan to avoid sort per insert)
    let worstIdx = 0;
    for (let i = 1; i < topCandidates.length; i++) {
        if (topCandidates[i].score > topCandidates[worstIdx].score) worstIdx = i;
    }
    topCandidates.splice(worstIdx, 1);
}

            if (!best || score < best.score) {
                second = best;
                best = rec;
            } else if (!second || score < second.score) {
                second = rec;
            }

            const rKey = String(rangeToTarget);
            const byR = stats.bestByRange[rKey];
            if (!byR || score < byR.score) {
                stats.bestByRange[rKey] = {
                    pos: `${leader.room.name}:${x},${y}`,
                    score,
                    raw: tileCost,
                    dist: distFromCreep,
                    r: rangeToTarget
                };
            }
        }
    }

    if (!best || !Number.isFinite(best.score)) {
        if (logEnabled) {
            logDuo(runtime, `fallback=no-candidate focus=${focus.roomName}:${focus.x},${focus.y}`);
        }
        return { anchorPos: focus, range: 0, reason: `fallback:no-candidate:${focusReason}` };
    }

    
    // Choose the best-scoring candidate (range constraints + combat matrix c
// Validate reachability on obstacle islands:
// Geometry cone + maxAnchorDist are NOT enough when walls/structures create disconnected pockets.
// So we PF-probe the top candidates and pick the best one that is actually reachable without
// forcing an immediate dive inside our safe minimum range.
const safeMinRange = (rr.style === 'ranged' && rangeHasTarget && kiteLikely && !harmlessOverrideApplied && !danceAggro)
    ? 4
    : minRange;

let chosen = best;
if (topCandidates && topCandidates.length > 0) {
    const sorted = topCandidates.slice().sort((a, b) => a.score - b.score);
    let picked = null;
    for (const cand of sorted) {
        const toPos = new RoomPosition(cand.x, cand.y, leader.room.name);
        if (isReachableAnchor(leader.pos, toPos, costs, rangeRef, safeMinRange, opts)) {
            picked = cand;
            break;
        }
        stats.rejUnreachable += 1;
    }
    if (picked) chosen = picked;
}

const anchorPos = new RoomPosition(chosen.x, chosen.y, leader.room.name);

    if (dbg) {
        dbg.last = {
            tick: Game.time,
            focus: `${focus.roomName}:${focus.x},${focus.y}`,
            focusReason,
            target: targetPos ? `${targetPos.roomName}:${targetPos.x},${targetPos.y}` : null,
            role: rr.style,
            prefRange,
            slack,
            searchRadius,
            weights,
            kite: { likely: kiteLikely, myTileCost: myTileCost, threshold: kiteCostThreshold, danceAggro },
            best: {
                pos: `${anchorPos.roomName}:${anchorPos.x},${anchorPos.y}`,
                score: best.score,
                raw: best.tileCost,
                dist: best.distFromCreep,
                r: best.rangeToTarget,
                rampart: best.rampart
            },
            second: second ? {
                pos: `${leader.room.name}:${second.x},${second.y}`,
                score: second.score,
                raw: second.tileCost,
                dist: second.distFromCreep,
                r: second.rangeToTarget,
                rampart: second.rampart
            } : null,
            stats
        };
    }

    if (logEnabled) {
        const bestMsg = `best=${anchorPos.roomName}:${anchorPos.x},${anchorPos.y}` +
            ` score=${best.score.toFixed(2)} raw=${best.tileCost} dist=${best.distFromCreep} r=${best.rangeToTarget}` +
            (best.rampart && (best.rampart.friendly || best.rampart.pub)
                ? ` rampart=${best.rampart.friendly ? 'friendly' : 'public'}`
                : '');

        const secondMsg = second
            ? ` second=${leader.room.name}:${second.x},${second.y}` +
              ` score=${second.score.toFixed(2)} raw=${second.tileCost} dist=${second.distFromCreep} r=${second.rangeToTarget}`
            : ' second=null';

        const r4 = stats.bestByRange['4'];
        const r4Msg = r4
            ? ` bestR4=${r4.pos} score=${r4.score.toFixed(2)} raw=${r4.raw} dist=${r4.dist} r=${r4.r}`
            : ' bestR4=none';

        logDuo(
            runtime,
            `tactics focus=${focus.roomName}:${focus.x},${focus.y}(${focusReason}) ` +
            `role=${rr.style} prefR=${prefRange} minR=${minRange} maxR=${maxRange} slack=${slack} searchR=${searchRadius} danceAggro=${danceAggro?1:0} danceFlips=${danceFlips} ` +
            bestMsg + secondMsg +
            ` cands total=${stats.total} inAO=${stats.inAO} costOk=${stats.costOk} rangeOk=${stats.rangeOk} supportOk=${stats.supportOk}` +
            ` rejAO=${stats.rejAO} rejBlocked=${stats.rejBlocked} rejR<min=${stats.rejRangeUnder} rejR>max=${stats.rejRangeOver} rejNoSupport=${stats.rejNoSupport} closeGate=${stats.closeGate}` +
            r4Msg
        );
    }

    
    // Update our local last-pos cache for this target so the next tick has a reliable vector,
    // even if combatMatrix didn't run before duoTactics this tick.
    if (target && target.pos && target.id && target.pos.roomName === leader.room.name) {
        setCachedEnemyLastPos(target);
    }

return {
        anchorPos,
        range: 0,
        reason: `anchor:${focusReason}:${rr.style}`,
        supportHintPos: chosen.supportHintPos || null
    };
}

module.exports = {
    decideAnchor
};
