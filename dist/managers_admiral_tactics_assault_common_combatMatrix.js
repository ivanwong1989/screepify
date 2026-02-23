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
const OFFSETS_R3 = [];
(function buildOffsets() {
    for (let dx = -3; dx <= 3; dx++) {
        for (let dy = -3; dy <= 3; dy++) {
            const d = Math.max(Math.abs(dx), Math.abs(dy));
            if (d <= 1) OFFSETS_R1.push([dx, dy, d]);
            if (d <= 3) OFFSETS_R3.push([dx, dy, d]);
        }
    }
})();

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
        ignoreCreepIds = null,
    } = opts || {};

    const costs = new PathFinder.CostMatrix();
    const terrain = room.getTerrain();

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

    // Structures baseline
    const structures = room.find(FIND_STRUCTURES);
    for (const s of structures) {
        const x = s.pos.x, y = s.pos.y;

        if (s.structureType === STRUCTURE_ROAD) {
            // roads are cheap, but don't overwrite later danger penalties (duoPlanner patch also helps)
            const cur = costs.get(x, y);
            if (cur !== 255 && cur > roadCost) costs.set(x, y, roadCost);
            continue;
        }

        if (s.structureType === STRUCTURE_CONTAINER) {
            continue; // passable
        }

        // Friendly/public ramparts passable
        if (s.structureType === STRUCTURE_RAMPART) {
            if (s.my || s.isPublic) continue;
            costs.set(x, y, 255);
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

        // tower danger
        towerMinCostNear = 200,  // <=5
        towerMinCostMid = 120,   // <=10
        towerMinCostFar = 60,    // <=20

        // if you want to ignore “harmless” hostiles (e.g. no attack parts)
        ignoreHarmless = true,
    } = opts || {};

    // --- Enemy creeps ---
    if (hostiles && hostiles.length) {
        for (const h of hostiles) {
            if (!h || !h.pos) continue;

            if (ignoreHarmless) {
                const atk = h.getActiveBodyparts(ATTACK);
                const rng = h.getActiveBodyparts(RANGED_ATTACK);
                if (atk + rng <= 0) continue;
            }

            const hx = h.pos.x, hy = h.pos.y;

            // melee (range 1)
            for (const [dx, dy, d] of OFFSETS_R1) {
                const x = hx + dx, y = hy + dy;
                if (x < 0 || x > 49 || y < 0 || y > 49) continue;
                addMax(costs, x, y, meleeMinCost);
            }

            // ranged (range 3) – stronger near
            for (const [dx, dy, d] of OFFSETS_R3) {
                const x = hx + dx, y = hy + dy;
                if (x < 0 || x > 49 || y < 0 || y > 49) continue;
                const c = (d <= 1) ? rangedMinCostNear : (d === 2 ? (rangedMinCostFar + 15) : rangedMinCostFar);
                addMax(costs, x, y, c);
            }
        }
    }

    // --- Towers (hostile / not mine) ---
    const towers = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER && !s.my });
    for (const t of towers) {
        const tx = t.pos.x, ty = t.pos.y;

        addMaxInRangeChebyshev(costs, tx, ty, 20, (d) => {
            if (d <= 5) return towerMinCostNear;
            if (d <= 10) return towerMinCostMid;
            if (d <= 20) return towerMinCostFar;
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

        const costs = buildBaseMatrix(room, base);

        // Pick hostiles list
        let hs = null;
        if (onlyOverlayInRoomName && roomName !== onlyOverlayInRoomName) {
            hs = null;
        } else if (hostilesByRoomName && hostilesByRoomName[roomName]) {
            hs = hostilesByRoomName[roomName];
        } else if (hostiles) {
            // If you passed a single hostiles array, it probably matches only one room anyway
            hs = hostiles;
        } else {
            hs = room.find(FIND_HOSTILE_CREEPS);
        }

        if (hs && hs.length) applyThreatOverlay(room, costs, hs, threat);

        cache[roomName] = costs;
        return costs;
    };
}

module.exports = {
    makeAssaultCombatRoomCallback,
};