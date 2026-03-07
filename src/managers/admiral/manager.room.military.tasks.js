const defenseTactics = require('managers_admiral_tactics_admiral.tactics.defense');
const assaultTactics = require('managers_admiral_tactics_admiral.tactics.assault');
const assaultCombatMatrix = require('managers_admiral_tactics_assault_common_combatMatrix');
const assaultMemory = require('managers_admiral_tactics_assault_common_memory');
const combatVis = require('managers_admiral_utils_admiral.visuals.combat');

// Debug helpers
function _milDbgEnabled() {
    return !!(global.Memory && Memory.debugDefense);
}

function _milDbgEvery(n) {
    n = n || 10;
    return (Game.time % n) === 0;
}

function _milDbgLog(msg) {
    if (!_milDbgEnabled()) return;
    if (!_milDbgEvery(10)) return;
    console.log(msg);
}

function isMilitaryRole(role) {
    return role === 'defender' || role === 'brawler' || role === 'assault' || role === 'drainer';
}

function getOwnedCreeps(roomName) {
    return Object.values(Game.creeps).filter(c =>
        c && c.my && c.memory && c.memory.room === roomName
    );
}

function selectMissions(room) {
    const allMissions = room._missions || [];
    return allMissions.filter(m => m && (m.type === 'defend' || m.type === 'defense' || m.type === 'assault'));
}

function isEligibleForMission(creep, mission) {
    if (!creep || !mission) return false;
    const role = creep.memory && creep.memory.role;
    if (mission.type === 'defend' || mission.type === 'defense') return role === 'defender' || role === 'brawler';
    if (mission.type === 'assault') {
        const assaultMode = mission.data && mission.data.assaultMode;
        if (assaultMode === 'dismantle') return role === 'assault' || role === 'dismantler';
        return role === 'assault';
    }
    return false;
}

function sortMissions(a, b) {
    const pa = Number.isFinite(a.priority) ? a.priority : 0;
    const pb = Number.isFinite(b.priority) ? b.priority : 0;
    if (pa !== pb) return pb - pa;
    return String(a.name || '').localeCompare(String(b.name || ''));
}

function sortCreepsByName(a, b) {
    return String(a.name || '').localeCompare(String(b.name || ''));
}

function isDuoMission(mission) {
    return mission && mission.type === 'assault' && mission.data && mission.data.mode === 'DUO';
}

// add helper near other helpers
function inferRoleFromMissionName(creep) {
    if (!creep || !creep.memory) return null;
    const m = creep.memory.missionName;
    if (!m || typeof m !== 'string') return null;
    if (m.slice(-7) === ':leader') return 'leader';
    if (m.slice(-8) === ':support') return 'support';
    return null;
}

function pickDuoPair(creeps) {
    const list = Array.isArray(creeps) ? creeps.slice() : [];
    if (list.length === 0) return { leader: null, support: null };

    // ✅ Source of truth: assigned missionName role
    let leader = list.find(c => inferRoleFromMissionName(c) === 'leader') || null;
    let support = list.find(c => inferRoleFromMissionName(c) === 'support') || null;

    // If somehow both point to same creep, drop support
    if (leader && support && leader.id === support.id) support = null;

    // Fill missing side with "any other creep"
    if (!leader && support) leader = list.find(c => c.id !== support.id) || null;
    if (!support && leader) support = list.find(c => c.id !== leader.id) || null;

    // If still missing both roles (shouldn't happen), keep stable but DO NOT swap by name:
    // just pick first two after sorting by name (pure fallback)
    if (!leader && !support) {
        list.sort(sortCreepsByName);
        leader = list[0] || null;
        support = list[1] || null;
    }

    return { leader, support };
}

function runDuoAssaultMissions(missions, assignments, context) {
    const duoBySquad = Object.create(null);
    const handled = new Set();

    missions.forEach(mission => {
        if (!isDuoMission(mission)) return;
        const squadKey = mission.data && mission.data.squadKey ? mission.data.squadKey : mission.name;
        if (!duoBySquad[squadKey]) duoBySquad[squadKey] = [];
        duoBySquad[squadKey].push(mission);
    });

    Object.keys(duoBySquad).forEach(squadKey => {
        const squadMissions = duoBySquad[squadKey];
        const assigned = [];
        squadMissions.forEach(m => {
            handled.add(m.name);
            const list = assignments[m.name] || [];
            list.forEach(c => assigned.push(c));
        });

        const pair = pickDuoPair(assigned);
        const representative = squadMissions.find(m => m.data && m.data.assaultRole === 'leader') || squadMissions[0];
        const plan = assaultTactics.planForPair(representative, pair.leader, pair.support, context);
        if (pair.leader && plan && plan.leaderTask) {
            pair.leader.memory.task = plan.leaderTask;
        }
        if (pair.support && plan && plan.supportTask) {
            pair.support.memory.task = plan.supportTask;
        }
    });

    return handled;
}

function runSoloAssaultMissions(missions, assignments, context) {
    const handled = new Set();

    for (const mission of missions) {
        if (!mission || mission.type !== 'assault') continue;
        if (mission.data && mission.data.mode === 'DUO') continue;

        handled.add(mission.name);

        const assigned = assignments[mission.name] || [];
        const creep = assigned.length > 0 ? assigned[0] : null;

        const task = assaultTactics.planForSolo(mission, creep, context);
        if (creep && !creep.spawning && task) {
            creep.memory.task = task;
        }
    }

    return handled;
}

function allocateCreeps(room, missions) {
    const ownedCreeps = getOwnedCreeps(room.name).filter(c => !c.spawning && isMilitaryRole(c.memory && c.memory.role));
    const assignments = Object.create(null);
    const assignedIds = new Set();
    const missionNames = new Set(missions.map(m => m.name));

    const sortedMissions = missions.slice().sort(sortMissions);
    for (const mission of sortedMissions) {
        const needed = Math.max(0, (mission.requirements && mission.requirements.count) || 0);
        if (!assignments[mission.name]) assignments[mission.name] = [];

        let preassigned = ownedCreeps.filter(c =>
            c.memory && c.memory.missionName === mission.name && isEligibleForMission(c, mission)
        );
        preassigned.sort(sortCreepsByName);
        if (preassigned.length > needed) preassigned = preassigned.slice(0, needed);

        for (const creep of preassigned) {
            if (assignedIds.has(creep.id)) continue;
            assignments[mission.name].push(creep);
            assignedIds.add(creep.id);
        }

        const remaining = needed - assignments[mission.name].length;
        if (remaining <= 0) continue;

        // IMPORTANT: do NOT "steal" creeps that are already bound to another live mission.
        // This was causing DUO squads (e.g. W) to hijack other DUO squads (e.g. Y) because
        // missions are allocated in name order and early missions would grab later ones.
        //
        // Allow reassignment only if:
        // - creep has no missionName, OR
        // - creep is already assigned to this mission, OR
        // - creep's missionName is stale (no longer exists on the board this tick)
        const candidates = ownedCreeps.filter(c => {
            if (assignedIds.has(c.id)) return false;
            if (!isEligibleForMission(c, mission)) return false;
            const cur = c.memory && c.memory.missionName;
            if (!cur) return true;
            if (cur === mission.name) return true;
            // If the mission is still live, keep ownership.
            if (missionNames.has(cur)) return false;
            // Otherwise it's stale and can be reclaimed.
            return true;
        });
        candidates.sort((a, b) => {
            const aMission = a.memory && a.memory.missionName;
            const bMission = b.memory && b.memory.missionName;
            const aPref = aMission === mission.name ? 0 : (aMission ? 2 : 1);
            const bPref = bMission === mission.name ? 0 : (bMission ? 2 : 1);
            if (aPref !== bPref) return aPref - bPref;
            return sortCreepsByName(a, b);
        });

        for (let i = 0; i < remaining && i < candidates.length; i++) {
            const creep = candidates[i];
            assignments[mission.name].push(creep);
            assignedIds.add(creep.id);
        }
    }

    for (const missionName of Object.keys(assignments)) {
        const list = assignments[missionName];
        for (const creep of list) {
            if (creep.memory) creep.memory.missionName = missionName;
        }
    }

    ownedCreeps.forEach(creep => {
        const memory = creep.memory || {};
        if (!memory.missionName) return;
        if (!isMilitaryRole(memory.role)) return;
        if (!missionNames.has(memory.missionName)) {
            delete memory.missionName;
            delete memory.task;
            delete memory.taskState;
            delete memory.drainState;
            return;
        }
        if (!assignedIds.has(creep.id)) {
            delete memory.missionName;
            delete memory.task;
            delete memory.taskState;
            delete memory.drainState;
        }
    });

    return assignments;
}

function runMission(mission, assignedCreeps, context) {
    if (!mission || !assignedCreeps || assignedCreeps.length === 0) return;
    const room = context.room;
    if (mission.type === 'defend' || mission.type === 'defense') {
        const hostiles = context.hostiles || [];
        const primaryTarget = defenseTactics.selectPrimaryTarget(hostiles);
        assignedCreeps.forEach(creep => {
            if (!creep.spawning) {
                defenseTactics.executeTactics(creep, hostiles, assignedCreeps, room, primaryTarget);
            }
        });
        return;
    }

    if (mission.type === 'assault') {
        assignedCreeps.forEach(creep => {
            if (!creep.spawning) assaultTactics.executeAssault(creep, mission, context);
        });
    }
}

/**
 * Military Tasker (Phase 2 refactor)
 */
var militaryTasks = {
    run: function(room) {
        const missions = selectMissions(room);
        
        if (_milDbgEnabled() && _milDbgEvery(10)) {
            const all = room._missions || [];
            if (all.length && missions.length === 0) {
                const types = all.slice(0, 6).map(m => (m && m.type) ? String(m.type) : 'null');
                _milDbgLog(`[MIL][tasks] ${room.name} selected=0 but _missions=${all.length}; types(sample)=${types.join(',')}`);
            }
        }
const assignments = allocateCreeps(room, missions);
        const cache = global.getRoomCache(room);
        const hostiles = cache.hostiles || []; // keep this for ctx.hostiles / defense logic

        // Restrict threat overlay to AO rooms only (cheap travel, expensive combat heatmap).
        // Build a set of AO target rooms from current assault missions.
        const overlayRooms = new Set();
        for (const m of missions) {
            if (!m || m.type !== 'assault') continue;
            const aoRoom = (m.data && m.data.ao && m.data.ao.targetRoom)
                ? m.data.ao.targetRoom
                : (m.data && m.data.targetRoom) ? m.data.targetRoom : null;
            if (aoRoom) overlayRooms.add(aoRoom);
        }

        // Build callbacks ONCE.
        // - travelRoomCallback: base-only (cheap), used for ROUTE/STAGE/TRAVEL PF
        // - combatRoomCallback: base + threat overlay, but overlay restricted to AO rooms only
        const travelRoomCallback = assaultCombatMatrix.makeAssaultCombatRoomCallback({
            // No overlay restriction needed because we don't add threat overlay at all.
            base: {
                plainCost: 2,
                swampCost: 10,
                roadCost: 1,
                avoidBorders: true,
                borderCost: 10,      // lighter for travel
                considerCreeps: false,
            },
            // Important: disable overlay entirely for travel
            threat: null
        });

        const combatRoomCallback = assaultCombatMatrix.makeAssaultCombatRoomCallback({
            onlyOverlayInRoomNames: overlayRooms,
            base: {
                plainCost: 2,
                swampCost: 10,
                roadCost: 1,
                avoidBorders: true,
                borderCost: 100,     // your current combat border behavior
                considerCreeps: false,
            },
            threat: {
                meleeMinCost: 70,
                rangedMinCostNear: 80,
                rangedMinCostFar: 45,

                towerMinCostNear: 45,   // <=5
                towerMinCostMid: 24,    // <=10
                towerMinCostFar: 10,    // <=20

                ignoreHarmless: true,
            },
        });

        // Back-compat: keep runtime.roomCallback pointing at COMBAT by default
        // (since solo/duo tactics expect runtime.roomCallback for the "combat matrix")
        const ctx = {
            room,
            hostiles,
            runtime: {
                //roomCallback: combatRoomCallback,
                travelRoomCallback,
                combatRoomCallback,
            }
        };

        const handledDuoMissions = runDuoAssaultMissions(missions, assignments, ctx);
        const handledSoloMissions = runSoloAssaultMissions(missions, assignments, ctx);

        for (const mission of missions) {
            if (handledDuoMissions.has(mission.name)) continue;
            if (handledSoloMissions.has(mission.name)) continue;
            runMission(mission, assignments[mission.name] || [], { room, hostiles });
        }

        // --------------------------------------
        // 🗺️ Combat CostMatrix Visualization (AO only)
        // --------------------------------------
        try {
            const v = (Memory && Memory.visuals) ? Memory.visuals : null;
            if (!v || !v.combatMatrix) {
                // debug toggle off
            } else {
                const VIS_EVERY = 1; // you can add v.combatEvery later if you want
                if ((Game.time % VIS_EVERY) === 0 && overlayRooms && overlayRooms.size) {
                    const step = Number.isFinite(+v.combatStep) ? Math.max(1, Math.min(10, +v.combatStep)) : 1;
                    const minCost = Number.isFinite(+v.combatMinCost) ? Math.max(0, Math.min(254, +v.combatMinCost)) : 20;
                    const showNumbers = !!v.combatNumbers;
                    const numberThreshold = Number.isFinite(+v.combatNumberThreshold)
                        ? Math.max(0, Math.min(254, +v.combatNumberThreshold))
                        : 120;
                    const showHeatmap = !!v.combatHeatmap;

                    // NEW knobs (optional)
                    const showLowNumbers = (v.combatLowNumbers == null) ? false : !!v.combatLowNumbers;
                    const lowNumberThreshold = Number.isFinite(+v.combatLowNumberThreshold)
                        ? Math.max(0, Math.min(254, +v.combatLowNumberThreshold))
                        : 3;
                    const showHostileThreat = (v.combatHostileThreat == null) ? true : !!v.combatHostileThreat;
                    const showTowerDanger = (v.combatTowerDanger == null) ? true : !!v.combatTowerDanger;
                    const towerDangerRange = Number.isFinite(+v.combatTowerDangerRange)
                        ? Math.max(1, Math.min(20, +v.combatTowerDangerRange))
                        : 8;

                    function parsePosString(s) {
                        // accepts "W8N3:13,16"
                        if (!s || typeof s !== 'string') return null;
                        const m = s.match(/^([WE]\d+[NS]\d+):(\d+),(\d+)$/);
                        if (!m) return null;
                        const roomName = m[1];
                        const x = Number(m[2]);
                        const y = Number(m[3]);
                        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
                        return { roomName, x, y };
                    }

                    // Collect anchors from runtimes (best-effort, non-fatal)
                    const anchorsByRoom = Object.create(null);

                    for (const m of missions) {
                        if (!m || m.type !== 'assault') continue;

                        // DUO
                        if (m.data && m.data.mode === 'DUO') {
                            const runtimeKey = (m.data && m.data.squadKey) ? m.data.squadKey : m.name;
                            if (assaultMemory && typeof assaultMemory.getDuoRuntime === 'function') {
                                const rt = assaultMemory.getDuoRuntime(runtimeKey);
                                const s = rt && rt.debug && rt.debug.tactical && rt.debug.tactical.anchorPos;
                                const p = parsePosString(s);
                                if (p) {
                                    if (!anchorsByRoom[p.roomName]) anchorsByRoom[p.roomName] = [];
                                    anchorsByRoom[p.roomName].push({
                                        roomName: p.roomName, x: p.x, y: p.y,
                                        kind: 'duo',
                                        label: (m.data && m.data.squadKey) ? String(m.data.squadKey).slice(0, 2) : 'D'
                                    });
                                }
                            }
                        } else {
                            // SOLO (best effort; only works if you have getSoloRuntime + same debug.tactical shape)
                            if (assaultMemory && typeof assaultMemory.getSoloRuntime === 'function') {
                                const rt = assaultMemory.getSoloRuntime(m.name);
                                const s = rt && rt.debug && rt.debug.tactical && rt.debug.tactical.anchorPos;
                                const p = parsePosString(s);
                                if (p) {
                                    if (!anchorsByRoom[p.roomName]) anchorsByRoom[p.roomName] = [];
                                    anchorsByRoom[p.roomName].push({
                                        roomName: p.roomName, x: p.x, y: p.y,
                                        kind: 'solo',
                                        label: 'S'
                                    });
                                }
                            }
                        }
                    }

                    for (const aoRoomName of overlayRooms) {
                        const aoRoom = Game.rooms[aoRoomName];
                        if (!aoRoom) continue; // must be visible

                        if (combatVis && typeof combatVis.drawCombatMatrix === 'function') {
                            combatVis.drawCombatMatrix(aoRoom, combatRoomCallback, {
                                step,
                                minCost,
                                legend: true,
                                showHeatmap,
                                showNumbers,
                                numberThreshold,

                                showLowNumbers,
                                lowNumberThreshold,
                                showHostileThreat,
                                showTowerDanger,
                                towerDangerRange,

                                anchorPositions: anchorsByRoom[aoRoomName] || []
                            });
                        }
                    }
                }
            }
        } catch (e) {
            // Never break missions because of visuals
        }


        // GC: if a DUO assault mission no longer exists on the mission board,
        // its runtime will not be touched and will be removed within 1 tick.
        assaultMemory.gcDuoRuntimesForOwner(room.name, 1);

        // GC SOLO runtime as well
        assaultMemory.gcSoloRuntimesForOwner(room.name, 1);
    }
};

module.exports = militaryTasks;
