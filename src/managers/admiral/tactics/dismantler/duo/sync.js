/**
 * Squad resolution helper.
 *
 * IMPORTANT:
 * - Never "fuzzy match" squadKey via indexOf (e.g. "W" matches many mission names).
 * - Prefer hard ownership:
 *    1) exact missionName match
 *    2) explicit assaultSquad match
 *    3) strict missionName pattern match for this squadKey (only as legacy fallback)
 */

function isStrictSquadMissionName(missionName, squadKey) {
    if (!missionName || !squadKey) return false;

    // Strict patterns we allow as legacy fallbacks.
    // Examples:
    // - assault:flag:W
    // - assault:flag:W:leader
    // - assault:flag:W:support
    // - assault:flag:W:duo:leader (etc)
    // NOTE: We intentionally avoid `indexOf(squadKey)`.
    const key = String(squadKey);
    const name = String(missionName);

    // Fast path: must contain ':flag:<key>' boundary.
    // This avoids matching 'W' inside other tokens.
    if (!name.includes(`:flag:${key}`)) return false;

    // If it contains ':flag:<key>' but the next char is part of a larger token, reject.
    // e.g. ':flag:W8' should NOT match squadKey 'W'.
    const idx = name.indexOf(`:flag:${key}`);
    const after = name[idx + (`:flag:${key}`).length] || '';
    if (after && after !== ':' && after !== '-') return false;

    // Also allow older formats that start with `assault:W...` if you ever had them.
    // Keep this conservative.
    if (name.startsWith(`assault:${key}`)) {
        const ch = name[`assault:${key}`.length] || '';
        if (ch && ch !== ':' && ch !== '-') return false;
        return true;
    }

    return true;
}

function getSquadCreeps(mission) {
    const data = (mission && mission.data) || {};
    const squadKey = data.squadKey;
    const missionName = mission && mission.name;

    return Object.values(Game.creeps).filter(c => {
        if (!c || !c.my || !c.memory) return false;
        if (c.memory.role !== 'assault') return false;

        // 1) Exact mission binding wins.
        if (missionName && c.memory.missionName === missionName) return true;

        // If mission has a squadKey, enforce hard boundaries.
        if (squadKey) {
            // 2) Explicit squad binding wins.
            if (c.memory.assaultSquad === squadKey) return true;

            // If creep is explicitly bound to a different squad, never adopt it.
            if (c.memory.assaultSquad && c.memory.assaultSquad !== squadKey) return false;

            // 3) Legacy fallback: strict missionName pattern match for this squadKey.
            // Only used when assaultSquad is absent.
            if (c.memory.missionName && isStrictSquadMissionName(c.memory.missionName, squadKey)) {
                return true;
            }
        }

        return false;
    });
}

function sortByName(a, b) {
    return String(a.name || '').localeCompare(String(b.name || ''));
}

function assignSquad(runtime, squad) {
    const members = squad.slice().sort(sortByName);
    const leader = members[0] || null;
    const support = members[1] || null;
    runtime.squad.leaderId = leader ? leader.id : null;
    runtime.squad.supportId = support ? support.id : null;
    return { leader, support };
}

function resolveSquad(creep, mission, runtime) {
    const squad = getSquadCreeps(mission);
    let leader = null;
    let support = null;

    if (runtime.squad.leaderId) {
        leader = squad.find(c => c.id === runtime.squad.leaderId) || null;
    }
    if (runtime.squad.supportId) {
        support = squad.find(c => c.id === runtime.squad.supportId) || null;
    }

    if (!leader || !support) {
        const assigned = assignSquad(runtime, squad);
        leader = assigned.leader;
        support = assigned.support;
    }

    let role = null;
    const legacyRole = mission && mission.data && mission.data.assaultRole;
    if (legacyRole) {
        role = legacyRole === 'support' ? 'support' : 'leader';
    } else if (leader && leader.id === creep.id) {
        role = 'leader';
    } else if (support && support.id === creep.id) {
        role = 'support';
    } else {
        role = 'leader';
    }

    return { squad, leader, support, role };
}

module.exports = {
    resolveSquad
};
