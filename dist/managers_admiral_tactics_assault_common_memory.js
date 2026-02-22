function ensureRoot() {
    if (!Memory) return null;
    if (!Memory.military) Memory.military = {};
    if (!Memory.military.runtime) Memory.military.runtime = {};
    return Memory.military.runtime;
}

function initLegacyRuntimeEntry() {
    return {
        phase: 'RENDEZVOUS',
        waypointIndex: 0,
        squad: {
            leaderId: null,
            supportId: null,
            lockUntil: null
        },
        debug: {}
    };
}

function initDuoRuntimeEntry() {
    return {
        version: 1,
        phase: 'ASSEMBLE',
        assembled: {
            done: false,
            at: 0,
            pos: null
        },
        route: {
            waypointIndex: 0
        },
        squad: {
            leaderId: null,
            supportId: null,
            lockUntil: 0
        },
        spawn: {
            allow: true,
            lastAllowAt: 0
        },
        wipe: {
            lastFullMissingAt: 0
        },
        regroup: false,
        debug: {},
        formation: {
            lastLeaderPos: null,
            lastSupportPos: null,
            lastLeaderPos2: null,
            lastSupportPos2: null,
            lastAnchorTarget: null,
            lastOffset: null,
            spinCount: 0
        }
    };
}

function getRuntime(missionName) {
    const root = ensureRoot();
    if (!root || !missionName) return initLegacyRuntimeEntry();
    if (!root[missionName]) root[missionName] = initLegacyRuntimeEntry();
    return root[missionName];
}

function resetRuntime(missionName) {
    const root = ensureRoot();
    if (!root || !missionName) return initLegacyRuntimeEntry();
    root[missionName] = initLegacyRuntimeEntry();
    return root[missionName];
}

module.exports = {
    getRuntime,
    resetRuntime,
    getDuoRuntime: function(missionName) {
        const root = ensureRoot();
        if (!root || !missionName) return initDuoRuntimeEntry();
        const entry = root[missionName];
        if (!entry || entry.version !== 1 || !entry.assembled || !entry.route) {
            root[missionName] = initDuoRuntimeEntry();
        }
        return root[missionName];
    },
    resetDuoRuntime: function(missionName) {
        const root = ensureRoot();
        if (!root || !missionName) return initDuoRuntimeEntry();
        root[missionName] = initDuoRuntimeEntry();
        return root[missionName];
    }
};
