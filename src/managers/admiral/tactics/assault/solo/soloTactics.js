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
    if (ranged) return { min: 3, pref: 3, max: 3, style: 'ranged' };
    if (melee) return { min: 1, pref: 1, max: 1, style: 'melee' };

    // Fallback behavior (non-combat body)
    return { min: 1, pref: 1, max: 1, style: 'worker' };
}

function ensureRuntime(runtime) {
    if (!runtime) return {};
    if (!runtime._soloTactics || typeof runtime._soloTactics !== 'object') runtime._soloTactics = {};
    return runtime._soloTactics;
}

function scoreTile(params) {
    // Lower is better.
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
    } = params;

    // Hard constraints:
    if (rangeToTarget < minRange || rangeToTarget > maxRange) return Infinity;
    if (!Number.isFinite(cost)) return Infinity;

    // Base: danger+terrain
    let score = cost;

    // Prefer being at preferred range (e.g. range=3 for ranged)
    score += Math.abs(rangeToTarget - prefRange) * 12;

    // Prefer closer-to-reach anchors, but not overly (danger should dominate)
    score += distFromCreep * 2.5;

    // Avoid borders/exits slightly (your matrix already adds borderCost; this is an extra nudge)
    if (border) score += 25;

    // Prefer rampart tiles a bit (bunkering), but keep it mild.
    if (onFriendlyRampart) score -= 8;
    if (onPublicRampart) score -= 3;

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
function decideAnchor(creep, runtime, flags, ao, target, opts) {
    opts = opts || {};
    if (!creep || !creep.pos || !creep.room) {
        return { anchorPos: null, range: 0, reason: 'no-creep' };
    }

    const rt = ensureRuntime(runtime);
    const dbg = opts.debug ? (rt.debug || (rt.debug = {})) : null;

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

    // Candidate enumeration:
    // - Sample all tiles in chebyshev square around focus within rr.max (<=3)
    // - Filter by AO
    // - Filter by passability via costs (255 blocks)
    const maxR = Math.max(1, Math.min(5, rr.max)); // safety cap
    const minX = Math.max(0, focus.x - maxR);
    const maxX = Math.min(49, focus.x + maxR);
    const minY = Math.max(0, focus.y - maxR);
    const maxY = Math.min(49, focus.y + maxR);

    let best = null;
    let second = null;

    // Minor optimization: if we are already at a valid anchor, keep it unless a clearly better tile exists.
    const biasStickiness = Number.isFinite(opts.stickiness) ? opts.stickiness : 0.6;

    for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
            const dToFocus = Math.max(Math.abs(x - focus.x), Math.abs(y - focus.y));
            if (dToFocus > rr.max) continue;

            const p = new RoomPosition(x, y, creep.room.name);

            if (!inAO(p, ao)) continue;

            const tileCost = costs.get(x, y);
            if (tileCost === 255) continue;

            // Range to target *if* we have one; else range to focus.
            const rangeRef = (targetPos && targetPos.roomName === creep.room.name) ? targetPos : focus;
            const rangeToTarget = rangeRef.getRangeTo(p);

            const distFromCreep = creep.pos.getRangeTo(p);

            // Rampart preference
            const rs = rampartStatus(creep.room, x, y);

            let score = scoreTile({
                cost: tileCost,
                distFromCreep,
                rangeToTarget,
                prefRange: rr.pref,
                minRange: rr.min,
                maxRange: rr.max,
                border: isBorder(x, y),
                onFriendlyRampart: rs.friendly,
                onPublicRampart: rs.pub
            });

            // Stickiness: if it's our current tile, reduce score slightly so we don't jitter.
            if (creep.pos.x === x && creep.pos.y === y) {
                score *= biasStickiness;
            }

            const rec = { x, y, score, tileCost, distFromCreep, rangeToTarget, rampart: rs };
            if (!best || score < best.score) {
                second = best;
                best = rec;
            } else if (!second || score < second.score) {
                second = rec;
            }
        }
    }

    if (!best || !Number.isFinite(best.score)) {
        return { anchorPos: focus, range: 0, reason: `fallback:no-candidate:${focusReason}` };
    }

    const anchorPos = new RoomPosition(best.x, best.y, creep.room.name);

    if (dbg) {
        dbg.last = {
            tick: Game.time,
            focus: `${focus.roomName}:${focus.x},${focus.y}`,
            focusReason,
            target: targetPos ? `${targetPos.roomName}:${targetPos.x},${targetPos.y}` : null,
            role: rr.style,
            prefRange: rr.pref,
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

    return {
        anchorPos,
        range: 0,
        reason: `anchor:${focusReason}:${rr.style}`
    };
}

module.exports = {
    decideAnchor
};
