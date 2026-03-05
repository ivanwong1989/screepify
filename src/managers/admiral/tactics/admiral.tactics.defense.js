/**
 * Admiral Defense Tactics (RAMPART BITERS)
 *
 * Design goals:
 * - Cheap CPU
 * - No chasing / no kiting
 * - Defenders live on ramparts and "bite" anything that comes adjacent
 * - Only considers hostiles that are near your ramparts (perimeter denial)
 *
 * API kept compatible with manager.room.military.tasks.js:
 * - selectPrimaryTarget(hostiles)
 * - executeTactics(creep, hostiles, defenders, room, primaryTarget)
 */

// ============================
// Debug (toggle with Memory.debugDefense = true)
// ============================
function _defDbgEnabled() {
    return !!(global.Memory && Memory.debugDefense);
}
function _defDbgEvery(n) {
    n = n || 2;
    return (Game.time % n) === 0;
}
function _defDbgLog(msg) {
    if (!_defDbgEnabled()) return;
    if (!_defDbgEvery(10)) return; // throttle
    console.log(msg);
}



function getRoomCacheKey(room) {
    return room ? room.name : 'unknown';
}

function getRampartCache(room) {
    if (!room) return { time: -1, ramparts: [] };
    if (!global._defRampartCache) global._defRampartCache = {};
    const key = getRoomCacheKey(room);
    const cur = global._defRampartCache[key];
    if (cur && cur.time === Game.time) return cur;

    const ramparts = room.find(FIND_MY_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_RAMPART
    });

    const next = { time: Game.time, ramparts };
    global._defRampartCache[key] = next;
    return next;
}

function isImpassableStructureType(t) {
    // Creeps can stand on: rampart, road, container
    // Everything else blocks the tile.
    return t !== STRUCTURE_RAMPART && t !== STRUCTURE_ROAD && t !== STRUCTURE_CONTAINER;
}

function isStandableRampart(rampart, creep) {
    if (!rampart || !rampart.pos) return false;

    // Optional: reject edges to avoid border nonsense (you already do this elsewhere)
    const x = rampart.pos.x, y = rampart.pos.y;
    if (x <= 1 || x >= 48 || y <= 1 || y >= 48) return false;

    // Terrain: if it's literal wall AND you don't own the rampart, it's not standable.
    // (For OWNED ramparts, standing on wall is allowed; so this is mostly defensive.)
    const terrain = rampart.pos.lookFor(LOOK_TERRAIN);
    if (terrain && terrain[0] === 'wall' && rampart.my !== true) return false;

    const structs = rampart.pos.lookFor(LOOK_STRUCTURES) || [];
    for (const s of structs) {
        if (!s || !s.structureType) continue;
        if (isImpassableStructureType(s.structureType)) return false; // spawn/extension/tower/etc
    }

    // If another creep is already on it, don't target it (prevents “I want your seat” deadlocks)
    const creeps = rampart.pos.lookFor(LOOK_CREEPS) || [];
    if (creeps.length && (!creep || creeps[0].name !== creep.name)) return false;

    return true;
}

function filterPressuringHostiles(hostiles, ramparts) {
    if (!Array.isArray(hostiles) || hostiles.length === 0) return [];
    if (!Array.isArray(ramparts) || ramparts.length === 0) return [];
    const out = [];
    for (const h of hostiles) {
        if (!h || !h.pos) continue;
        const d = minRangeToAnyRampart(h.pos, ramparts);
        if (d <= 3) out.push(h); // same perimeter rule as pickHostileNearRamparts
    }
    return out;
}

function pickClosestStandableRampart(defender, ramparts, targetPos) {
    if (!defender || !Array.isArray(ramparts) || ramparts.length === 0) return null;
    let best = null;
    let bestD = Infinity;

    for (const r of ramparts) {
        if (!isStandableRampart(r, defender)) continue;
        const d = targetPos ? r.pos.getRangeTo(targetPos) : defender.pos.getRangeTo(r.pos);
        if (d < bestD) { bestD = d; best = r; }
    }
    return best;
}

function isOnRampart(creep) {
    if (!creep || !creep.pos) return false;
    const here = creep.pos.lookFor(LOOK_STRUCTURES);
    if (!here || here.length === 0) return false;
    return here.some(s => s.structureType === STRUCTURE_RAMPART);
}

function minRangeToAnyRampart(pos, ramparts) {
    if (!pos || !ramparts || ramparts.length === 0) return Infinity;
    let best = Infinity;
    for (const r of ramparts) {
        const d = r.pos.getRangeTo(pos);
        if (d < best) best = d;
        if (best <= 1) return best;
    }
    return best;
}

function pickHostileNearRamparts(hostiles, ramparts) {
    if (!hostiles || hostiles.length === 0) return null;
    if (!ramparts || ramparts.length === 0) return null;

    // Prefer hostiles that are *closest to your ramparts* (perimeter pressure)
    let best = null;
    let bestD = Infinity;
    let bestHits = Infinity;

    for (const h of hostiles) {
        if (!h || !h.pos) continue;
        const d = minRangeToAnyRampart(h.pos, ramparts);

        // Key rule: ignore anything not pressuring perimeter
        // (prevents chasing, prevents wandering outside)
        if (d > 3) continue;

        if (d < bestD || (d === bestD && h.hits < bestHits)) {
            best = h;
            bestD = d;
            bestHits = h.hits;
        }
    }

    return best;
}

function pickBestRampartForHostiles(defender, ramparts, hostiles, anchorPos) {
    if (!defender || !ramparts || ramparts.length === 0 || !hostiles || hostiles.length === 0) return null;
    // Pre-pull hostile positions (no repeated .pos allocations)
    const hpos = hostiles.map(h => h.pos);

    let best = null;
    let bestScore = Infinity;

    for (const r of ramparts) {
        if (!r || !r.pos) continue;

        // NEW: don't pick ramparts we can't actually stand on (spawn tile, tower tile, etc.)
        if (!isStandableRampart(r, defender)) continue;

        // Skip edge tiles (optional, but helps avoid weird “border dance”)
        const x = r.pos.x, y = r.pos.y;
        if (x <= 1 || x >= 48 || y <= 1 || y >= 48) continue;

        // If your defender wants “only unoccupied ramparts”, keep this:
        // if (r.pos.lookFor(LOOK_CREEPS).length) continue;

        // 1) enemy proximity: minimize range to nearest hostile
        let minRH = 999;
        for (const p of hpos) {
            const d = r.pos.getRangeTo(p);
            if (d < minRH) {
                minRH = d;
                if (minRH <= 1) break; // can’t beat adjacent
            }
        }

        // Hard cap: if you only want “engagement” ramparts, ignore far ones
        // if (minRH > 6) continue;

        // 2) tie breaker: defender travel distance
        const dCreep = defender.pos.getRangeTo(r.pos);

        // 3) optional: bias staying near anchor
        const dAnchor = anchorPos ? r.pos.getRangeTo(anchorPos) : 0;

        // Score: enemy proximity dominates, then creep distance, then anchor
        // (weights chosen so “closer to hostile” always beats “closer to creep”)
        const score = (minRH * 1000) + (dCreep * 10) + dAnchor;

        if (score < bestScore) {
            bestScore = score;
            best = r;
        }
    }

    return best;
}


function pickRampartClosestTo(room, ramparts, targetPos) {
    if (!room || !ramparts || ramparts.length === 0) return null;

    // If no target, park near spawn/controller to avoid clogging sources.
    if (!targetPos) {
        const cache = global.getRoomCache(room);
        const spawnList = cache && cache.myStructuresByType && cache.myStructuresByType[STRUCTURE_SPAWN];
        const anchor = (spawnList && spawnList[0]) || room.controller;        if (!anchor) return ramparts[0];
        targetPos = anchor.pos;
    }

    let best = null;
    let bestD = Infinity;
    for (const r of ramparts) {
        const d = r.pos.getRangeTo(targetPos);
        if (d < bestD) { bestD = d; best = r; }
    }
    return best;
}

var admiralDefenseTactics = {
    selectPrimaryTarget: function(hostiles) {
        if (!Array.isArray(hostiles) || hostiles.length === 0) return null;

        // Keep something stable for callers: lowest hits among "dangerous" else lowest hits
        const dangerous = hostiles.filter(h =>
            h && (h.getActiveBodyparts(ATTACK) > 0 || h.getActiveBodyparts(RANGED_ATTACK) > 0 || h.getActiveBodyparts(HEAL) > 0)
        );
        const pool = dangerous.length ? dangerous : hostiles;
        return pool.sort((a, b) => a.hits - b.hits)[0];
    },

    executeTactics: function(creep, hostiles, defenders, room, primaryTarget) {
        if (!creep || creep.spawning || !room) return;

        const mission = (room._missions || []).find(m => m && m.name === creep.memory.missionName);

        
        _defDbgLog(
            `[DEF][tactics] ${creep.name} t=${Game.time} room=${room.name} ` +
            `hostiles=${(hostiles && hostiles.length) || 0} ` +
            `missionName=${creep.memory.missionName || '-'} missionsInRoom=${(room._missions && room._missions.length) || 0} ` +
            `missionFound=${mission ? 1 : 0}`
        );
        // Hard rule: never roam outside defendRoom
        const defendRoom = mission && mission.data && mission.data.defendRoom;
        if (defendRoom && creep.room && creep.room.name !== defendRoom) {
            
            _defDbgLog(`[DEF][return] ${creep.name} in=${creep.room.name} defendRoom=${defendRoom} moving to anchor`);
            const a = mission.data && mission.data.anchorPos;
            creep.memory.task = {
                actions: [],
                moveTarget: a ? { x: a.x, y: a.y, roomName: a.roomName } : null,
                range: 1,
                moveOpts: { reusePath: 20 }
            };
            return;
        }

        const { ramparts } = getRampartCache(room);

        
        _defDbgLog(`[DEF][tactics] ${creep.name} ramparts=${(ramparts && ramparts.length) || 0} onRamp=${isOnRampart(creep) ? 1 : 0} pos=${creep.pos.x},${creep.pos.y}`);
        // No ramparts? degrade: only attack if adjacent, otherwise do nothing
        if (!ramparts || ramparts.length === 0) {
            _defDbgLog(`[DEF][degrade] ${creep.name} no-ramparts; will only bite if adjacent`);

            const t = (primaryTarget && primaryTarget.pos) ? primaryTarget : creep.pos.findClosestByRange(hostiles);
            if (t && creep.pos.isNearTo(t)) {
                creep.memory.task = { actions: [{ action: 'attack', targetId: t.id }], moveTarget: null, range: 0 };
            }
            return;
        }

        // Only consider perimeter-relevant hostiles
        const target = pickHostileNearRamparts(hostiles, ramparts);

        if (!target) {
            // No *perimeter pressure* yet.
            // If hostiles exist in-room but are still far from your ramparts, we want to **stage early**
            // on the rampart that best contests their approach (instead of parking near anchor and reacting late).
            const anchorPos = mission && mission.data && mission.data.anchorPos
                ? new RoomPosition(mission.data.anchorPos.x, mission.data.anchorPos.y, mission.data.anchorPos.roomName)
                : null;

            const hostileCount = (hostiles && hostiles.length) || 0;

            // Stage early if there are hostiles anywhere in the defend room.
            // This keeps the "no chasing" rule (we still only move to a rampart),
            // but chooses the *most relevant* rampart before they get adjacent.
            let ramp = null;
            if (hostileCount > 0) {
                ramp = pickBestRampartForHostiles(creep, ramparts, hostiles, anchorPos);
            } else {
                // No hostiles: park near anchor to avoid clogging econ.
                ramp = pickRampartClosestTo(room, ramparts, anchorPos);
            }

            // ensure standable; else pick closest standable near anchor / creep
            if (ramp && !isStandableRampart(ramp, creep)) {
                const refPos = (hostileCount > 0 && hostiles[0] && hostiles[0].pos) ? hostiles[0].pos : anchorPos;
                ramp = pickClosestStandableRampart(creep, ramparts, refPos);
            }

            // FINAL pick (the thing we will actually move to)
            const finalRamp = ramp || null;

            _defDbgLog(
                `[DEF][park] ${creep.name} ramp=${finalRamp ? `${finalRamp.pos.x},${finalRamp.pos.y}` : 'null'} ` +
                `alreadyOnRamp=${isOnRampart(creep) ? 1 : 0} pos=${creep.pos.x},${creep.pos.y} ` +
                `stageHostiles=${hostileCount}`
            );

            if (finalRamp && (!isOnRampart(creep) || !creep.pos.isEqualTo(finalRamp.pos))) {
                creep.memory.task = {
                    actions: [],
                    moveTarget: { x: finalRamp.pos.x, y: finalRamp.pos.y, roomName: finalRamp.pos.roomName },
                    range: 0,
                    moveOpts: { reusePath: 20 }
                };
            }
            return;
        }

        // Biter rule: attack ONLY if we are ON a rampart and adjacent
        if (isOnRampart(creep) && creep.pos.isNearTo(target)) {
            creep.memory.task = { actions: [{ action: 'attack', targetId: target.id }], moveTarget: null, range: 0 };
            return;
        }

        // Otherwise: occupy rampart that best contests hostiles (deny safe ramparts)
        const anchorPos = mission && mission.data && mission.data.anchorPos
            ? new RoomPosition(mission.data.anchorPos.x, mission.data.anchorPos.y, mission.data.anchorPos.roomName)
            : null;

        // Use only perimeter-pressuring hostiles so we don't drift to nonsense anchors
        const pressuring = filterPressuringHostiles(hostiles, ramparts);
        const ramp = pickBestRampartForHostiles(
            creep,
            ramparts,
            pressuring.length ? pressuring : [target], // fallback to target if list empty
            anchorPos
        );

        // Fallback: if best ramp is null (or everything was un-standable), move to closest standable rampart near the target
        const finalRamp = ramp || pickClosestStandableRampart(creep, ramparts, target && target.pos ? target.pos : null);

        _defDbgLog(
            `[DEF][pick] ${creep.name} choseRamp=${ramp ? `${ramp.pos.x},${ramp.pos.y}` : 'null'} ` +
            `target=${target ? `${target.pos.x},${target.pos.y}` : 'null'}`
        );

        if (finalRamp && (!isOnRampart(creep) || !creep.pos.isEqualTo(finalRamp.pos))) {
            creep.memory.task = {
                actions: [],
                moveTarget: { x: finalRamp.pos.x, y: finalRamp.pos.y, roomName: finalRamp.pos.roomName },
                range: 0,
                moveOpts: { reusePath: 20 }
            };
        }
    },

    cleanupMissions: function(defenders, allMissions) {
        (defenders || []).forEach(creep => {
            if (creep.memory.missionName && !(allMissions || []).find(m => m.name === creep.memory.missionName)) {
                delete creep.memory.missionName;
                delete creep.memory.task;
            }
        });
    }
};

module.exports = admiralDefenseTactics;