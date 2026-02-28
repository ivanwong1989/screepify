// managers_admiral_tactics_assault_solo_soloTactics.js
//
// SOLO tactical anchor selection for ENGAGE phase.
// - Does NOT issue attacks/heals. Only decides "where should we stand" (anchorPos).
// - Uses assault combatMatrix costs (danger heat + base obstacles) to rank candidate tiles.
// - Keeps logic lightweight: sample tiles around the current target (or AO center) and pick best.
// - Controller owns phase logic (RENDEZVOUS/STAGE/RETREAT/etc).
//
// Export:
//   decideAnchor(creep, runtime, flags, ao, target, opts?) -> { anchorPos, range, reason, debug? }
//
// Notes:
// - anchorPos is movement anchor, NOT the "thing to shoot/heal".
// - target is still selected by engage.selectTarget() (creep/structure/etc).

const { makeAssaultCombatRoomCallback } = require('managers_admiral_tactics_assault_common_combatMatrix');

function toRoomPos(p) {
    if (!p) return null;
    if (p instanceof RoomPosition) return p;
    if (p.pos) p = p.pos;
    const roomName = p.roomName || (p.room && p.room.name);
    if (roomName == null || p.x == null || p.y == null) return null;
    return new RoomPosition(p.x, p.y, roomName);
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

function getRoleRanges(creep) {
    const ranged = hasPart(creep, RANGED_ATTACK);
    const melee = hasPart(creep, ATTACK);

    // Strict assault behavior:
    // Ranged: always strive for range 3 (no drifting into range 2).
    // Melee: always strive for range 1.
    if (ranged) return { min: 3, pref: 3, max: 4, style: 'ranged' };
    if (melee) return { min: 1, pref: 1, max: 1, style: 'melee' };

    // Fallback behavior (non-combat body)
    return { min: 1, pref: 1, max: 1, style: 'worker' };
}

function ensureRuntime(runtime) {
    if (!runtime) return {};
    if (!runtime._soloTactics || typeof runtime._soloTactics !== 'object') runtime._soloTactics = {};
    return runtime._soloTactics;
}

function nowTick() {
    return (typeof Game !== 'undefined' && Game.time != null) ? Game.time : 0;
}

function logSolo(runtime, message) {
    if (!global || typeof global.debug !== 'function') return;
    global.debug('admiral.assault.solo', `[assault.solo] ${message}`);

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


function isReachableAnchor(creep, anchorPos, costs, rangeRef, safeMinRange, opts) {
    if (!creep || !creep.pos || !anchorPos) return false;
    if (creep.pos.roomName !== anchorPos.roomName) return false;

    // If already at anchor, it's reachable.
    if (creep.pos.x === anchorPos.x && creep.pos.y === anchorPos.y) return true;

    const topKMaxOps = Number.isFinite(opts && opts.reachMaxOps) ? Math.max(200, Math.floor(opts.reachMaxOps)) : 900;
    const maxPathLen = Number.isFinite(opts && opts.reachMaxPathLen) ? Math.max(1, Math.floor(opts.reachMaxPathLen)) : 12;
    const checkSteps = Number.isFinite(opts && opts.reachCheckSteps) ? Math.max(0, Math.floor(opts.reachCheckSteps)) : 3;

    // Probe a single-room path using the same combatMatrix costs as a CostMatrix.
    const res = PathFinder.search(
        creep.pos,
        { pos: anchorPos, range: 0 },
        {
            maxOps: topKMaxOps,
            maxRooms: 1,
            plainCost: 2,
            swampCost: 10,
            roomCallback: function(roomName) {
                if (roomName !== creep.pos.roomName) return false;
                return costs || false;
            }
        }
    );

    if (!res || res.incomplete) return false;

    const path = res.path || [];
    if (path.length > maxPathLen) return false;

    // "No-dive" guard: the early steps toward the anchor should not force us inside safeMinRange.
    if (Number.isFinite(safeMinRange) && safeMinRange > 0 && rangeRef && typeof rangeRef.getRangeTo === 'function') {
        for (let i = 0; i < path.length && i < checkSteps; i++) {
            const step = path[i];
            if (!step) continue;
            const r = rangeRef.getRangeTo(step);
            if (r < safeMinRange) return false;
        }
    }

    return true;
}

function decideAnchor(creep, runtime, flags, ao, target, opts) {
    opts = opts || {};
    if (!creep || !creep.pos || !creep.room) {
        return { anchorPos: null, range: 0, reason: 'no-creep' };
    }

    const rt = ensureRuntime(runtime);
    const dbg = opts.debug ? (rt.debug || (rt.debug = {})) : null;
    const logEnabled = (opts.logSolo != null) ? !!opts.logSolo : !!opts.debug;

    // Choose "focus" position to anchor around (usually target; else AO center; else attackPos)
    const targetPos = toRoomPos(target);
    const centerPos = toRoomPos(ao && ao.centerPos);
    const attackPos = toRoomPos(flags && flags.attackPos);

    let focus = null;
    let focusReason = 'none';
    if (targetPos && targetPos.roomName === creep.room.name && inAO(targetPos, ao)) {
        focus = targetPos;
        focusReason = 'target';
    } else if (attackPos && attackPos.roomName === creep.room.name && inAO(attackPos, ao)) {
        focus = attackPos;
        focusReason = 'attackPos';
    } else if (centerPos && centerPos.roomName === creep.room.name) {
        focus = centerPos;
        focusReason = 'ao.centerPos';
    } else {
        focus = creep.pos;
        focusReason = 'self';
    }

    // If no visible room / cross-room focus, just hold route-level behavior.
    if (!focus || focus.roomName !== creep.room.name) {
        return { anchorPos: null, range: 0, reason: 'no-focus' };
    }

    const rr = getRoleRanges(creep);

    // Build/get combat cost matrix for this room.
    const roomCallback = makeAssaultCombatRoomCallback({
        avoidBorders: true,
        borderCost: 10,
        considerCreeps: false
    });

    const costs = roomCallback(creep.room.name);
    // If matrix is unavailable, degrade to a simple "stand on focus (or near it)".
    if (!costs) {
        return {
            anchorPos: focus,
            range: 0,
            reason: `fallback:no-matrix:${focusReason}`
        };
    }


    // Kiting trigger (single system):
    // If our *current* tile is "hot" per combat matrix, prefer buffer ring r>=4 (for ranged) by penalizing r<4 candidates.
    // Tuning:
    // - opts.kiteCostThreshold (default 20): enter kite posture when creep's current tile cost >= threshold.
    // - opts.weights.closeGate: penalty applied to r<4 candidates while kiting (default 5000).
    const kiteCostThreshold = Number.isFinite(opts.kiteCostThreshold) ? opts.kiteCostThreshold : 20;
    const myTileCostRaw = costs.get(creep.pos.x, creep.pos.y);
    const myTileCost = (myTileCostRaw === 255) ? 254 : myTileCostRaw;
    const kiteLikely = Number.isFinite(myTileCost) && myTileCost >= kiteCostThreshold;


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
// - opts.maxAnchorDist (default 6): reject anchors farther than this (range from creep).
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

    const rangeHasTarget = !!(targetPos && targetPos.roomName === creep.room.name);
    const rangeRef = rangeHasTarget ? targetPos : focus;

    // Range policy (simple):
    // - Prefer rr.pref (r=3 for ranged)
    // - Allow rr.min..rr.max (ranged: 3..4), so we can pick a buffer ring when kiting (r=4) without drifting out of engage.
    // - Rely on the combat matrix's predictive overlay to naturally push us outward when the enemy advances.
    const prefRange = rangeHasTarget ? rr.pref : 0;

    let minRange = rangeHasTarget ? Math.max(0, rr.min - slack) : 0;
    let maxRange = rangeHasTarget ? Math.min(10, rr.max + slack) : 50;

    // --- Harmless enemy override ---
    // If target has no ATTACK/RANGED_ATTACK parts, we can safely close a bit more to finish it.
    if (rr.style === 'ranged' && rangeHasTarget && isHarmlessEnemy(target)) {
        minRange = 2;
        maxRange = 3;
    }

    // Search radius: bigger than maxRange so we can actually find candidates when slack>0.
    let searchRadius = Number.isFinite(opts.searchRadius) ? Math.max(1, Math.floor(opts.searchRadius)) : 10;
    searchRadius = Math.max(searchRadius, maxRange + 1);

    // If AO radius is set, don't waste CPU searching beyond it (within same room).
    const aoRadius = (ao && ao.centerPos && ao.centerPos.roomName === creep.room.name) ? (Number(ao.radius) || 0) : 0;
    if (aoRadius > 0) searchRadius = Math.min(searchRadius, aoRadius);

    const minX = Math.max(0, focus.x - searchRadius);
    const maxX = Math.min(49, focus.x + searchRadius);
    const minY = Math.max(0, focus.y - searchRadius);
    const maxY = Math.min(49, focus.y + searchRadius);

    let best = null;
    let second = null;

    // Reachability guard (top-K PF probe) to avoid selecting anchors behind wall/structure islands.
    // Tuning:
    // - opts.topK (default 10): number of best candidates to PF-validate
    // - opts.reachMaxOps (default 900): PF budget per candidate
    // - opts.reachMaxPathLen (default 12): reject anchors requiring long detours
    // - opts.reachCheckSteps (default 3): reject anchors whose early steps dive inside safe range
    const topK = Number.isFinite(opts.topK) ? Math.max(1, Math.floor(opts.topK)) : 10;
    const topCandidates = [];

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
            const p = new RoomPosition(x, y, creep.room.name);

            if (!inAO(p, ao)) continue;

            const tileCost = costs.get(x, y);
            if (tileCost === 255) continue;

            // Range reference is decided once above (target when available; else focus).
            const rangeToTarget = rangeRef.getRangeTo(p);

            const distFromCreep = creep.pos.getRangeTo(p);

            // Short-horizon reachability: don't pick anchors that are too far to realize soon.
            if (distFromCreep > maxAnchorDist) continue;

            // "Same-side" cone filter:
            // Reject candidates that are on the far side of the target relative to our current approach vector,
            // since reaching them typically requires passing close to/through the enemy.
            if (!disableCone && rangeHasTarget && targetPos) {
                const ax = creep.pos.x - targetPos.x;
                const ay = creep.pos.y - targetPos.y;
                const bx = x - targetPos.x;
                const by = y - targetPos.y;

                const dot = ax * bx + ay * by;
                if (dot <= 0) continue; // behind target

                const a2 = ax * ax + ay * ay;
                const b2 = bx * bx + by * by;
                if (a2 > 0 && b2 > 0) {
                    const cos2 = coneCos * coneCos;
                    if ((dot * dot) < (a2 * b2 * cos2)) continue;
                }
            }


            // Rampart preference
            const rs = rampartStatus(creep.room, x, y);

            // Single system: kite based on *our current tile cost*.
            // If we're on a hot tile, make r<4 expensive so we pick r=4 anchors when possible.
            // Refinement (from duoTactics):
            // - Only enforce the "step-in risk" gate when the target can actually MOVE.
            // - Allow opting out via opts.allowRange3VsMobile=true (less conservative).
            let closeRiskPenalty = 0;
            if (rr.style === 'ranged' && rangeHasTarget && kiteLikely) {
                const wg = (weights && Number.isFinite(weights.closeGate)) ? weights.closeGate : 5000;

                const allowRange3VsMobile = !!opts.allowRange3VsMobile;

                // Best-effort "mobile" check (works for real creeps and creep-like objects).
                const isMobile = !!(
                    target &&
                    (
                        (typeof Creep !== 'undefined' && target instanceof Creep && target.getActiveBodyparts && target.getActiveBodyparts(MOVE) > 0) ||
                        (target.body && Array.isArray(target.body) && target.body.some(p => p && p.type === MOVE && (p.hits == null || p.hits > 0)))
                    )
                );

                if (!allowRange3VsMobile && isMobile && rangeToTarget < 4) {
                    closeRiskPenalty += wg;
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
                weights
            });

            if (closeRiskPenalty > 0) score += closeRiskPenalty;

            // Stickiness: if it's our current tile, reduce score slightly so we don't jitter.
            if (creep.pos.x === x && creep.pos.y === y) {
                score *= biasStickiness;
            }

            const rec = { x, y, score, tileCost, distFromCreep, rangeToTarget, rampart: rs };

            // Track top candidates for reachability probing (keep sorted by score, trim to topK).
            topCandidates.push(rec);
            topCandidates.sort((a, b) => a.score - b.score);
            if (topCandidates.length > topK) topCandidates.length = topK;

            if (!best || score < best.score) {
                second = best;
                best = rec;
            } else if (!second || score < second.score) {
                second = rec;
            }
        }
    }

    // === Reachability guard: validate top candidates with a cheap single-room PF probe ===
    // This prevents selecting anchors that are "geometrically valid" but topologically unreachable
    // without detouring around wall/structure islands (which often causes a forced dive toward the enemy).
    let chosenRec = best;
    if (!(opts && opts.disableReachabilityProbe) && topCandidates.length > 0) {
        // For ranged vs target, keep early steps outside a safe range band (no-dive).
        const safeMinRange = (rr.style === 'ranged' && rangeHasTarget)
            ? (kiteLikely ? 4 : (Number.isFinite(minRange) ? minRange : 0))
            : 0;

        let checked = 0;
        let rejected = 0;
        for (let i = 0; i < topCandidates.length; i++) {
            const cand = topCandidates[i];
            if (!cand) continue;
            checked += 1;

            const candPos = new RoomPosition(cand.x, cand.y, creep.room.name);
            if (!isReachableAnchor(creep, candPos, costs, rangeHasTarget ? targetPos : null, safeMinRange, opts)) {
                rejected += 1;
                continue;
            }

            chosenRec = cand;
            break;
        }

        if (dbg) {
            dbg.reach = {
                topK,
                checked,
                rejected,
                safeMinRange,
                kiteLikely
            };
        }
    }



    if (!best || !Number.isFinite(best.score)) {
        return { anchorPos: focus, range: 0, reason: `fallback:no-candidate:${focusReason}` };
    }

    
    // Choose the best-scoring candidate (range constraints + combat matrix costs already applied).
    const chosen = chosenRec || best;

    const anchorPos = new RoomPosition(chosen.x, chosen.y, creep.room.name);

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
            best: {
                pos: `${anchorPos.roomName}:${anchorPos.x},${anchorPos.y}`,
                score: best.score,
                raw: best.tileCost,
                dist: best.distFromCreep,
                r: best.rangeToTarget,
                rampart: best.rampart
            },
            second: second ? {
                pos: `${creep.room.name}:${second.x},${second.y}`,
                score: second.score,
                raw: second.tileCost,
                dist: second.distFromCreep,
                r: second.rangeToTarget,
                rampart: second.rampart
            } : null
        };
    }

    if (logEnabled) {
        const bestMsg = `best=${anchorPos.roomName}:${anchorPos.x},${anchorPos.y}` +
            ` score=${best.score.toFixed(2)} raw=${best.tileCost} dist=${best.distFromCreep} r=${best.rangeToTarget}` +
            (best.rampart && (best.rampart.friendly || best.rampart.pub)
                ? ` rampart=${best.rampart.friendly ? 'friendly' : 'public'}`
                : '');

        const secondMsg = second
            ? ` second=${creep.room.name}:${second.x},${second.y}` +
              ` score=${second.score.toFixed(2)} raw=${second.tileCost} dist=${second.distFromCreep} r=${second.rangeToTarget}`
            : ' second=null';

        logSolo(
            runtime,
            `tactics focus=${focus.roomName}:${focus.x},${focus.y}(${focusReason}) ` +
            `role=${rr.style} prefR=${prefRange} slack=${slack} searchR=${searchRadius} ` +
            bestMsg + secondMsg
        );
    }

    return {
        anchorPos,
        range: 0,
        reason: `anchor:${focusReason}:${rr.style}`
    };
}

module.exports = {
    decideAnchor
};
