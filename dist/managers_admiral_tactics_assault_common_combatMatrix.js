/**
 * Combat-aware CostMatrix overlay for assault.
 *
 * Goal:
 * - Keep base travel costs sane (roads/terrain/structures)
 * - Add "danger heat" so PF avoids stepping into enemy ranges / tower zones
 *
 * IMPORTANT:
 * - This returns a CostMatrix for visible rooms only.
 * - For non-visible rooms, return undefined so PF falls back.
 */

const { getHostilesInRoom, filterOutAllies } = require('managers_admiral_tactics_assault_common_threat');

function clamp255(v) {
    if (v <= 0) return 0;
    if (v >= 254) return 254; // 255 is treated as impassable
    return v | 0;
}

function posKey(x, y) {
    return (x << 6) | y; // 0..49 fits in 6 bits
}

// Precompute offsets for small radii (fast + no allocations per tick)
const OFFSETS_R1 = [];
const OFFSETS_R2 = [];
const OFFSETS_R3 = [];
(function buildOffsets() {
    for (let dx = -3; dx <= 3; dx++) {
        for (let dy = -3; dy <= 3; dy++) {
            const d = Math.max(Math.abs(dx), Math.abs(dy));
            if (d <= 1) OFFSETS_R1.push([dx, dy, d]);
            if (d <= 2) OFFSETS_R2.push([dx, dy, d]);
            if (d <= 3) OFFSETS_R3.push([dx, dy, d]);
        }
    }
})();

// Possible 1-tick enemy centers (stay + 8 neighbors). Used for "prediction envelope" overlay.
const OFFSETS_STEP = [
    [0, 0],
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1],           [0, 1],
    [1, -1],  [1, 0],  [1, 1],
];

function addMax(costs, x, y, minCost) {
    if (x <= 0 || x >= 49 || y <= 0 || y >= 49) return; // avoid exits by default (your border system handles exits)
    const cur = costs.get(x, y);
    if (cur === 255) return;
    if (cur < minCost) costs.set(x, y, clamp255(minCost));
}

function addMaxInRangeChebyshev(costs, cx, cy, range, minCostByDistFn) {
    const minX = Math.max(1, cx - range);
    const maxX = Math.min(48, cx + range);
    const minY = Math.max(1, cy - range);
    const maxY = Math.min(48, cy + range);
    for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
            const d = Math.max(Math.abs(x - cx), Math.abs(y - cy));
            const c = minCostByDistFn(d);
            if (c > 0) addMax(costs, x, y, c);
        }
    }
}

function buildBaseMatrix(room, opts) {
    const {
        plainCost = 2,
        swampCost = 10,
        roadCost = 1,
        avoidBorders = true,
        borderCost = 10,
        considerCreeps = false,   // we usually don't want "creeps as obstacles" in combat
        creepCost = 50,
        portalCost = 1,
        ignoreCreepIds = null,
        // NEW: rampart preference (applied only if enabled by caller)
        friendlyRampartBonus = 10,      // e.g. 2 or 3
        preferPublicRamparts = false,  // default off (public ≠ safe bunker)
        // NEW: "rampart sink" mode (owned room combat) - make friendly ramparts as cheap as roads
        rampartSinkInOwnedRoom = false,
        rampartSinkCost = 1,            // normally keep at roadCost
        rampartSinkOutsidePenalty = 2,  // penalty added to non-road, non-rampart tiles
    } = opts || {};

    const costs = new PathFinder.CostMatrix();
    const terrain = room.getTerrain();

    function clamp01(v, fallback) {
        const n = Number(v);
        if (!Number.isFinite(n)) return fallback;
        if (n <= 0) return 0;
        if (n >= 1) return 1;
        return n;
    }

    function getLastVectorPredictedCenter(h) {
        if (!h || !h.id || !h.pos) return null;
        const map = global._enemyLastPos;
        if (!map) return null;
        const rec = map[h.id];
        // rec is updated during roomCache build for the *current* tick, so we need previous tick.
        // We store only the latest, so vector uses a cached "prev" if present.
        const prev = rec && rec.prev && rec.prev.time === Game.time - 1 ? rec.prev : null;
        if (!prev) return null;
        if (prev.roomName !== h.pos.roomName) return null;
        const dx = h.pos.x - prev.x;
        const dy = h.pos.y - prev.y;
        if (dx === 0 && dy === 0) return null;
        const cx = h.pos.x + dx;
        const cy = h.pos.y + dy;
        if (cx < 0 || cx > 49 || cy < 0 || cy > 49) return null;
        if (terrain.get(cx, cy) & TERRAIN_MASK_WALL) return null;
        return { x: cx, y: cy };
    }

    // Terrain baseline
    for (let x = 0; x < 50; x++) {
        for (let y = 0; y < 50; y++) {
            const t = terrain.get(x, y);
            if (t & TERRAIN_MASK_WALL) {
                costs.set(x, y, 255);
            } else if (t & TERRAIN_MASK_SWAMP) {
                costs.set(x, y, swampCost);
            } else {
                costs.set(x, y, plainCost);
            }
        }
    }


// If enabled, we track road + friendly-rampart tiles so we can later make ramparts a "sink"
// (i.e., as cheap as roads) in owned-room combat.
const _trackRampartSink = !!rampartSinkInOwnedRoom;
const _roadTiles = _trackRampartSink ? new Set() : null;           // posKey(int)
const _friendlyRampartTiles = _trackRampartSink ? new Set() : null; // posKey(int)

    // Structures baseline
    const structures = room.find(FIND_STRUCTURES);
    for (const s of structures) {
        const x = s.pos.x, y = s.pos.y;

        if (s.structureType === STRUCTURE_ROAD) {
            // roads are cheap, but don't overwrite later danger penalties (duoPlanner patch also helps)
            const cur = costs.get(x, y);
            if (cur !== 255 && cur > roadCost) costs.set(x, y, roadCost);
            if (_roadTiles) _roadTiles.add(posKey(x, y));
            continue;
        }

        if (s.structureType === STRUCTURE_CONTAINER) {
            continue; // passable
        }

        // Ramparts:
        // - enemy/private ramparts block
        // - friendly ramparts are passable
        // - optionally prefer friendly ramparts by reducing cost a bit
        if (s.structureType === STRUCTURE_RAMPART) {
            const isFriendly = !!s.my;
            const isPublic = !!s.isPublic;
            if (_friendlyRampartTiles && isFriendly) _friendlyRampartTiles.add(posKey(x, y));

            if (!(isFriendly || isPublic)) {
                costs.set(x, y, 255);
                continue;
            }

            const shouldPrefer = isFriendly || (preferPublicRamparts && isPublic);
            const bonus = shouldPrefer ? (Number(friendlyRampartBonus) || 0) : 0;

            if (bonus > 0) {
                const cur = costs.get(x, y);
                // Don't override walls/blocks, and don't beat roads (keep roads king)
                if (cur !== 255 && cur > roadCost) {
                    const next = Math.max(roadCost, cur - bonus);
                    if (next < cur) costs.set(x, y, next);
                }
            }

            continue;
        }

        // Portals
        if (s.structureType === STRUCTURE_PORTAL) {
            costs.set(x, y, portalCost);
            continue;
        }

        // All other structures block
        costs.set(x, y, 255);
    }

    // Optionally treat creeps as soft obstacles
    if (considerCreeps) {
        const creeps = room.find(FIND_CREEPS);
        for (const c of creeps) {
            if (ignoreCreepIds && ignoreCreepIds.has(c.id)) continue;
            const x = c.pos.x, y = c.pos.y;
            const cur = costs.get(x, y);
            if (cur !== 255 && cur < creepCost) costs.set(x, y, creepCost);
        }
    }


// ------------------------------------------------------------
// Friendly rampart "sink" mode (owned-room combat helper)
// ------------------------------------------------------------
// Intuition:
// - Roads are the global minima (cost=1).
// - In owned rooms, our ramparts are also "safe" tiles to stand on.
// - So during combat, we want PF to happily route *onto* ramparts, not just tolerate them.
//
// Implementation:
// - If room is mine AND we have friendly ramparts:
//   - Set friendly rampart tiles to rampartSinkCost (default 1, matching roads).
//   - Add a small penalty to everything else (except roads) so ramparts become true minima.
if (_trackRampartSink &&
    room.controller && room.controller.my &&
    _friendlyRampartTiles && _friendlyRampartTiles.size) {

    const sinkCost = Number.isFinite(Number(rampartSinkCost)) ? (Number(rampartSinkCost) | 0) : roadCost;
    const outsidePenalty = Number.isFinite(Number(rampartSinkOutsidePenalty)) ? (Number(rampartSinkOutsidePenalty) | 0) : 0;

    if (outsidePenalty > 0) {
        for (let x = 0; x < 50; x++) {
            for (let y = 0; y < 50; y++) {
                const cur = costs.get(x, y);
                if (cur === 255) continue;

                const k = posKey(x, y);

                // Keep roads as minima too
                if (_roadTiles && _roadTiles.has(k)) continue;

                // Skip friendly ramparts; they will be set to sinkCost below
                if (_friendlyRampartTiles.has(k)) continue;

                costs.set(x, y, clamp255(cur + outsidePenalty));
            }
        }
    }

    // Finally, enforce friendly ramparts as sink tiles (normally cost=1)
    for (const k of _friendlyRampartTiles) {
        const x = (k >> 6) & 63;
        const y = (k & 63);
        const cur = costs.get(x, y);
        if (cur === 255) continue;
        const next = Math.max(1, Math.min(254, sinkCost));
        if (cur !== next) costs.set(x, y, next);
    }
}

    // Borders slightly expensive
    if (avoidBorders) {
        for (let i = 0; i < 50; i++) {
            // x borders
            {
                const c0 = costs.get(0, i);
                if (c0 !== 255) costs.set(0, i, clamp255(c0 + borderCost));

                const c49 = costs.get(49, i);
                if (c49 !== 255) costs.set(49, i, clamp255(c49 + borderCost));
            }

            // y borders
            {
                const cY0 = costs.get(i, 0);
                if (cY0 !== 255) costs.set(i, 0, clamp255(cY0 + borderCost));

                const cY49 = costs.get(i, 49);
                if (cY49 !== 255) costs.set(i, 49, clamp255(cY49 + borderCost));
            }
        }
    }

    return costs;
}

function applyThreatOverlay(room, costs, hostiles, opts) {
    const {
        // enemy creep danger
        meleeMinCost = 60,
        rangedMinCostNear = 70,
        rangedMinCostFar = 40,

        // NEW: Creep-only EDPT (Expected Damage Per Tick) overlay (optional)
        // When enabled, creep threat costs become damage-aware instead of fixed rings.
        // This helps avoid "range-1 hugs" (e.g. Source Keeper between you and target) by
        // making adjacency measurably worse than "step+hit" distance.
        useCreepEdpt = false,
        // Cost per 1 damage/tick. Example: melee 2 ATTACK parts => 60 dmg/tick => ~13 cost at 0.22.
        // Tune upward if you want to avoid danger more aggressively.
        edptScale = 0.22,
        // Minimum cost to paint for any non-zero EDPT threat
        edptMinCost = 10,
        // For melee at range 2: "step + hit" pressure weight
        meleeStepWeight = 0.75,
        // Ranged distance weights (range 3): slightly higher pressure when closer
        rangedNearWeight = 1.25,   // d<=1
        rangedMidWeight = 1.10,    // d==2
        rangedFarWeight = 1.00,    // d==3

        // tower danger (reduced so combat planner still finds anchors)
        towerMinCostNear = 45,   // <=5
        towerMinCostMid = 24,    // <=10
        towerMinCostFar = 10,    // <=20

        // if you want to ignore “harmless” hostiles (e.g. no attack parts)
        ignoreHarmless = true,

        // NEW: In owned rooms, friendly ramparts are a "shield".
        // If enabled, we do NOT paint threat costs onto friendly rampart tiles.
        ignoreThreatOnFriendlyRamparts = true,

        // Prediction envelope: also paint danger from where the enemy could be after 1 move this tick.
        // This reduces "surprise" hits without inflating true ranges.
        predictEnemyStep = true,
        predictScale = 0.6,

        // Prediction bias: if we saw the hostile move last tick, bias the envelope toward its
        // observed motion vector ("most likely next tile"). This makes prediction feel intentional.
        predictUseLastVector = true,
        // Weighting inside the 1-tick prediction envelope
        predictUniformWeight = 0.35,   // 0..1, applies to all 8 neighbors
        predictVectorWeight = 1.0,     // 0..1, extra weight at the vector-predicted tile
        predictVectorSpreadWeight = 0.55, // 0..1, weight around the vector tile (its neighbors)
    } = opts || {};

    // --- Enemy creeps ---
    // Note: costmatrix is built at start-of-tick using current positions.
    // Enemies can move at end-of-tick, so we optionally add a 1-step "envelope" as medium-weight danger.
    const terrain = room.getTerrain();

    // Friendly ramparts can act as a true shield in owned rooms.
    // Optionally treat them as "safe tiles" even inside threat rings.
    const _rampartSafe =
        !!ignoreThreatOnFriendlyRamparts &&
        room.controller && room.controller.my;

    const _friendlyRampartSet = _rampartSafe ? new Set() : null;
    if (_friendlyRampartSet) {
        const ramps = room.find(FIND_STRUCTURES, { filter: r => r.structureType === STRUCTURE_RAMPART && r.my });
        for (const r of ramps) _friendlyRampartSet.add(posKey(r.pos.x, r.pos.y));
    }

    function addMaxThreat(x, y, minCost) {
        if (_friendlyRampartSet && _friendlyRampartSet.has(posKey(x, y))) return;
        addMax(costs, x, y, minCost);
    }

    function addMaxInRangeChebyshevThreat(cx, cy, range, minCostByDistFn) {
        const minX = Math.max(1, cx - range);
        const maxX = Math.min(48, cx + range);
        const minY = Math.max(1, cy - range);
        const maxY = Math.min(48, cy + range);
        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
                const d = Math.max(Math.abs(x - cx), Math.abs(y - cy));
                const c = minCostByDistFn(d);
                if (c > 0) addMaxThreat(x, y, c);
            }
        }
    }


    function clamp01(v, fallback) {
        const n = Number(v);
        if (!Number.isFinite(n)) return fallback;
        if (n <= 0) return 0;
        if (n >= 1) return 1;
        return n;
    }

    function getLastVectorPredictedCenter(h) {
        if (!h || !h.id || !h.pos) return null;
        const map = global._enemyLastPos;
        if (!map) return null;
        const rec = map[h.id];
        // rec is updated during roomCache build for the *current* tick, so we need previous tick.
        // We store only the latest, so vector uses a cached "prev" if present.
        const prev = rec && rec.prev && rec.prev.time === Game.time - 1 ? rec.prev : null;
        if (!prev) return null;
        if (prev.roomName !== h.pos.roomName) return null;
        const dx = h.pos.x - prev.x;
        const dy = h.pos.y - prev.y;
        if (dx === 0 && dy === 0) return null;
        const cx = h.pos.x + dx;
        const cy = h.pos.y + dy;
        if (cx < 0 || cx > 49 || cy < 0 || cy > 49) return null;
        if (terrain.get(cx, cy) & TERRAIN_MASK_WALL) return null;
        return { x: cx, y: cy };
    }

        function applyCreepThreatAt(cx, cy, meleeCost, rangedNearCost, rangedFarCost, atkParts, rngParts) {
        // Skip impossible centers (shouldn't happen for current pos, but can for predicted)
        if (cx < 0 || cx > 49 || cy < 0 || cy > 49) return;
        if (terrain.get(cx, cy) & TERRAIN_MASK_WALL) return;

        const atk = (Number(atkParts) || 0);
        const rng = (Number(rngParts) || 0);

        const hasMelee = atk > 0;
        const hasRanged = rng > 0;

        // Screeps constants:
        // - ATTACK part = 30 dmg/tick (melee)
        // - RANGED_ATTACK part = 10 dmg/tick (ranged)
        const meleeDps = hasMelee ? (atk * 30) : 0;
        const rangedDps = hasRanged ? (rng * 10) : 0;

        function edptToCost(edpt) {
            // Scale EDPT into 1..254, keep a small floor so small threats still show.
            const scale = Number(edptScale) || 0;
            const floor = Number(edptMinCost) || 0;
            const c = Math.floor((Number(edpt) || 0) * scale);
            return clamp255(Math.max(floor, c));
        }

        // ---------------------------------------------------------------------
        // Melee
        // - d<=1: certain melee DPS
        // - d==2: "step + hit" pressure (weighted)
        // ---------------------------------------------------------------------
        if (hasMelee) {
            if (useCreepEdpt) {
                const c1 = edptToCost(meleeDps);
                const c2 = edptToCost(meleeDps * (Number(meleeStepWeight) || 0.75));

                // d<=1
                for (const [dx, dy] of OFFSETS_R1) {
                    const x = cx + dx, y = cy + dy;
                    if (x < 0 || x > 49 || y < 0 || y > 49) continue;
                    addMaxThreat(x, y, c1);
                }

                // d==2 (Chebyshev ring)
                for (const [dx, dy] of OFFSETS_R2) {
                    const d = Math.max(Math.abs(dx), Math.abs(dy));
                    if (d !== 2) continue;
                    const x = cx + dx, y = cy + dy;
                    if (x < 0 || x > 49 || y < 0 || y > 49) continue;
                    addMaxThreat(x, y, c2);
                }
            } else {
                // Old behavior: flat melee ring to range 2 (models "enemy can step 1 + hit")
                for (const [dx, dy] of OFFSETS_R2) {
                    const x = cx + dx, y = cy + dy;
                    if (x < 0 || x > 49 || y < 0 || y > 49) continue;
                    addMaxThreat(x, y, meleeCost);
                }
            }
        }

        // ---------------------------------------------------------------------
        // Ranged (range 3)
        // ---------------------------------------------------------------------
        if (hasRanged) {
            if (useCreepEdpt) {
                const wNear = Number(rangedNearWeight) || 1.25;
                const wMid  = Number(rangedMidWeight) || 1.10;
                const wFar  = Number(rangedFarWeight) || 1.00;

                for (const [dx, dy, d] of OFFSETS_R3) {
                    const x = cx + dx, y = cy + dy;
                    if (x < 0 || x > 49 || y < 0 || y > 49) continue;

                    let w = wFar;
                    if (d <= 1) w = wNear;
                    else if (d === 2) w = wMid;

                    const c = edptToCost(rangedDps * w);
                    addMaxThreat(x, y, c);
                }
            } else {
                // Old behavior: near vs far min-cost
                for (const [dx, dy, d] of OFFSETS_R3) {
                    const x = cx + dx, y = cy + dy;
                    if (x < 0 || x > 49 || y < 0 || y > 49) continue;
                    const c = (d <= 1) ? rangedNearCost : (d === 2 ? (rangedFarCost + 15) : rangedFarCost);
                    addMaxThreat(x, y, c);
                }
            }
        }
    }

    if (hostiles && hostiles.length) {
        for (const h of hostiles) {
            if (!h || !h.pos) continue;

            const atk = h.getActiveBodyparts(ATTACK);
            const rng = h.getActiveBodyparts(RANGED_ATTACK);

            if (ignoreHarmless && (atk + rng <= 0)) continue;

            const hx = h.pos.x, hy = h.pos.y;

            // 1) Center at creep threat?
            applyCreepThreatAt(hx, hy, meleeMinCost, rangedMinCostNear, rangedMinCostFar, atk, rng);

            // 2) Predicted 1-step envelope (medium weight)
            // Old behaviour: uniform 8-neighbour envelope. New: still keep a soft uniform envelope,
            // but bias *hard* toward the hostile's observed motion vector (if available).
            if (predictEnemyStep && predictScale > 0) {
                const uniformW = clamp01(predictUniformWeight, 0.35);
                const vecW = clamp01(predictVectorWeight, 1.0);
                const vecSpreadW = clamp01(predictVectorSpreadWeight, 0.55);
                const useVec = !!predictUseLastVector;

                function scaledCosts(weight) {
                    const w = Math.max(0, Math.min(1, Number(weight) || 0));
                    const scale = predictScale * w;
                    return {
                        melee: Math.max(1, Math.floor(meleeMinCost * scale)),
                        rngNear: Math.max(1, Math.floor(rangedMinCostNear * scale)),
                        rngFar: Math.max(1, Math.floor(rangedMinCostFar * scale)),
                    };
                }

                // 2a) Soft uniform envelope around current position (optional; keeps behaviour stable)
                if (uniformW > 0) {
                    const c = scaledCosts(uniformW);
                    for (const [sx, sy] of OFFSETS_STEP) {
                        if (sx === 0 && sy === 0) continue; // already applied current center
                        const cx = hx + sx, cy = hy + sy;
                        if (cx < 0 || cx > 49 || cy < 0 || cy > 49) continue;
                        if (terrain.get(cx, cy) & TERRAIN_MASK_WALL) continue;
                        applyCreepThreatAt(cx, cy, c.melee, c.rngNear, c.rngFar, atk, rng);
                    }
                }

                if (useVec && (vecW > 0 || vecSpreadW > 0)) {
                    const vecCenter = getLastVectorPredictedCenter(h);
                    if (vecCenter) {
                        // 2b) Strong bias on the "most likely" next center (vector-based)
                        if (vecW > 0) {
                            const c = scaledCosts(vecW);
                            applyCreepThreatAt(vecCenter.x, vecCenter.y, c.melee, c.rngNear, c.rngFar, atk, rng);
                        }

                        // 2c) And a medium envelope around that vector tile (prevents being tricked by 1-tile sidestep)
                        if (vecSpreadW > 0) {
                            const c = scaledCosts(vecSpreadW);
                            for (const [sx, sy] of OFFSETS_STEP) {
                                const cx = vecCenter.x + sx, cy = vecCenter.y + sy;
                                if (cx < 0 || cx > 49 || cy < 0 || cy > 49) continue;
                                if (terrain.get(cx, cy) & TERRAIN_MASK_WALL) continue;
                                applyCreepThreatAt(cx, cy, c.melee, c.rngNear, c.rngFar, atk, rng);
                            }
                        }
                    }
                }
            }
        }
    }

    // --- Towers (hostile / not mine) ---
    const towers = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER && !s.my });
    for (const t of towers) {
        const tx = t.pos.x, ty = t.pos.y;

        addMaxInRangeChebyshevThreat(tx, ty, 20, (d) => {
            const energyScale = ((t.store && t.store.energy) || 0) / TOWER_CAPACITY;

            if (d <= 5)  return Math.floor(towerMinCostNear * energyScale);
            if (d <= 10) return Math.floor(towerMinCostMid  * energyScale);
            if (d <= 20) return Math.floor(towerMinCostFar  * energyScale);
            return 0;
        });
    }

    return costs;
}

/**
 * Factory for a PF roomCallback to be passed as context.runtime.roomCallback
 *
 * opts:
 * - base: base-cost settings
 * - threat: overlay settings
 * - hostilesByRoomName (optional): if you have hostiles for multiple rooms
 */
function makeAssaultCombatRoomCallback(opts) {
    const {
        base = null,
        threat = null,
        hostiles = null,
        hostilesByRoomName = null,
        // If true, only apply threat overlay in the "current room" you pass in.
        // Otherwise, if room is visible, we’ll overlay using room.find hostiles.
        onlyOverlayInRoomName = null,
        onlyOverlayInRoomNames = null, // NEW: Set<string> | string[] | { [roomName]: true }
    } = opts || {};

    // Per-tick cache to avoid rebuilding matrices multiple times per room in same tick
    let cacheTick = -1;
    let cache = Object.create(null);

    return function(roomName) {
        if (cacheTick !== Game.time) {
            cacheTick = Game.time;
            cache = Object.create(null);
        }
        if (cache[roomName]) return cache[roomName];

        const room = Game.rooms[roomName];
        if (!room) return undefined; // not visible: let PF handle it

        // Build base matrix.
        // If hostiles exist, we optionally prefer friendly ramparts (combat posture).
        let costs = buildBaseMatrix(room, base);

        // Pick hostiles list
        let hs = null;

        // Restrict overlay rooms (single or many).
        // - onlyOverlayInRoomName: string
        // - onlyOverlayInRoomNames: Set<string> | string[] | { [roomName]: true }
        let overlayAllowed = true;
        if (onlyOverlayInRoomName) {
            overlayAllowed = (roomName === onlyOverlayInRoomName);
        } else if (onlyOverlayInRoomNames) {
            if (onlyOverlayInRoomNames instanceof Set) {
                overlayAllowed = onlyOverlayInRoomNames.has(roomName);
            } else if (Array.isArray(onlyOverlayInRoomNames)) {
                overlayAllowed = onlyOverlayInRoomNames.includes(roomName);
            } else if (typeof onlyOverlayInRoomNames === 'object') {
                overlayAllowed = !!onlyOverlayInRoomNames[roomName];
            }
        }

        if (!overlayAllowed) {
            hs = null;
        } else if (hostilesByRoomName && hostilesByRoomName[roomName]) {
            hs = hostilesByRoomName[roomName];
        } else if (hostiles) {
            // If you passed a single hostiles array, it probably matches only one room anyway
            hs = hostiles;
        } else {
            // Prefer roomCache hostiles (filters allies). Fallback filters allies manually.
            hs = getHostilesInRoom(room);
        }

        // Safety: if caller supplied hostiles arrays, still ensure allies are excluded.
        if (hs && hs.length) hs = filterOutAllies(hs);

        // If there are hostiles, rebuild base matrix with rampart preference enabled.
        // This avoids "rampart surfing" during peaceful travel.
        if (hs && hs.length) {
            const bonus = (base && base.friendlyRampartBonus != null)
                ? base.friendlyRampartBonus
                : 2; // sensible default when in combat

            if (bonus > 0) {
                const combatBase = Object.assign({}, base, {
                    friendlyRampartBonus: bonus,
                    // keep default false unless caller explicitly wants public ramparts
                    preferPublicRamparts: !!(base && base.preferPublicRamparts),
                    // NEW: In owned-room combat, prefer standing on friendly ramparts.
                    // Default ON in combat unless caller explicitly disables.
                    rampartSinkInOwnedRoom: (base && base.rampartSinkInOwnedRoom != null)
                        ? !!base.rampartSinkInOwnedRoom
                        : true,
                    rampartSinkCost: (base && base.rampartSinkCost != null) ? base.rampartSinkCost : 1,
                    rampartSinkOutsidePenalty: (base && base.rampartSinkOutsidePenalty != null) ? base.rampartSinkOutsidePenalty : 2,
                });
                costs = buildBaseMatrix(room, combatBase);
            }
        }

        if (threat && hs && hs.length) {
            //const h0 = hs[0];
            //console.log(`[CM] t=${Game.time} room=${roomName} h0=${h0.name || h0.id} pos=${h0.pos.x},${h0.pos.y}`);
            applyThreatOverlay(room, costs, hs, threat);
        }

        cache[roomName] = costs;
        return costs;
    };
}

module.exports = {
    makeAssaultCombatRoomCallback,
};