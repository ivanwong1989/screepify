const defenseTactics = require('managers_admiral_tactics_admiral.tactics.defense');
const assaultTactics = require('managers_admiral_tactics_admiral.tactics.assault');
const assaultCombatMatrix = require('managers_admiral_tactics_assault_common_combatMatrix');
const assaultMemory = require('managers_admiral_tactics_assault_common_memory');
const combatVis = require('managers_admiral_utils_admiral.visuals.combat');

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
    return allMissions.filter(m => m.type === 'defend' || m.type === 'assault');
}

function isEligibleForMission(creep, mission) {
    if (!creep || !mission) return false;
    const role = creep.memory && creep.memory.role;
    if (mission.type === 'defend') return role === 'defender' || role === 'brawler';
    if (mission.type === 'assault') return role === 'assault';
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

function pickDuoPair(creeps) {
    const list = Array.isArray(creeps) ? creeps.slice() : [];
    if (list.length === 0) return { leader: null, support: null };
    let leader = list.find(c => c.memory && c.memory.assaultRole === 'leader') || null;
    let support = list.find(c => c.memory && c.memory.assaultRole === 'support') || null;

    if (leader && support && leader.id === support.id) support = null;
    if (!leader && support) leader = list.find(c => c.id !== support.id) || null;
    if (!support && leader) support = list.find(c => c.id !== leader.id) || null;

    if (!leader && !support) {
        list.sort(sortCreepsByName);
        leader = list[0] || null;
        support = list[1] || null;
    } else if (leader && support && String(leader.name || '') > String(support.name || '')) {
        const swap = leader;
        leader = support;
        support = swap;
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
    if (mission.type === 'defend') {
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
            if (!creep.spawning) assaultTactics.executeAssault(creep, mission);
        });
    }
}

/**
 * Military Tasker (Phase 2 refactor)
 */
var militaryTasks = {
    run: function(room) {
        const missions = selectMissions(room);
        const assignments = allocateCreeps(room, missions);
        const cache = global.getRoomCache(room);
        const hostiles = cache.hostiles || [];
        // 1) build callback ONCE
        const roomCallback = assaultCombatMatrix.makeAssaultCombatRoomCallback({
            hostiles,
            onlyOverlayInRoomName: room.name, // keep overlay local (safe + cheap)
            base: {
                plainCost: 2,
                swampCost: 10,
                roadCost: 1,
                avoidBorders: true,
                borderCost: 100,
                considerCreeps: false,
            },
            threat: {
                meleeMinCost: 70,
                rangedMinCostNear: 80,
                rangedMinCostFar: 45,

                towerMinCostNear: 220,
                towerMinCostMid: 140,
                towerMinCostFar: 70,

                ignoreHarmless: true,
            },
        });

        // 2) visualize it (behind a toggle)
        if (Memory.visuals && Memory.visuals.combatMatrix) {
            combatVis.drawCombatMatrix(room, roomCallback, {
                step: 1,       // 1 to avoid visuals bug
                minCost: Memory.visuals.combatMinCost || 20, // hide low costs
                showNumbers: !!Memory.visuals.combatNumbers,
                numberThreshold: Memory.visuals.combatNumberThreshold || 120,
            });
        }

        const handledDuoMissions = runDuoAssaultMissions(missions, assignments, {
            room,
            hostiles,
            runtime: { roomCallback }   
        });

        for (const mission of missions) {
            if (handledDuoMissions.has(mission.name)) continue;
            runMission(mission, assignments[mission.name] || [], { room, hostiles });
        }

        // GC: if a DUO assault mission no longer exists on the mission board,
        // its runtime will not be touched and will be removed within 1 tick.
        assaultMemory.gcDuoRuntimesForOwner(room.name, 1);
    }
};

module.exports = militaryTasks;
