function getSquadCreeps(mission) {
    const data = (mission && mission.data) || {};
    const squadKey = data.squadKey;
    const missionName = mission && mission.name;
    return Object.values(Game.creeps).filter(c => {
        if (!c || !c.my || !c.memory) return false;
        if (c.memory.role !== 'assault') return false;
        if (missionName && c.memory.missionName === missionName) return true;
        if (squadKey && c.memory.missionName && c.memory.missionName.indexOf(squadKey) >= 0) return true;
        if (squadKey && c.memory.assaultSquad === squadKey) return true;
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
