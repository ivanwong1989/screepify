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
        meta: {
            lastSeenTick: 0,
            ownerRoom: null,
            runtimeKey: null
        },
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

function touchDuoRuntime(runtime, mission, runtimeKey) {
    if (!runtime) return;
    if (!runtime.meta) runtime.meta = {};
    runtime.meta.lastSeenTick = (typeof Game !== 'undefined' && Game.time != null) ? Game.time : 0;

    const ownerRoom =
        (mission && mission.data && (mission.data.sponsorRoom || mission.data.ownerRoom)) || null;

    if (ownerRoom) runtime.meta.ownerRoom = ownerRoom;
    if (runtimeKey) runtime.meta.runtimeKey = runtimeKey;
}

function gcDuoRuntimesForOwner(ownerRoom, graceTicks) {
    const root = ensureRoot();
    if (!root || !ownerRoom) return;

    const g = Number.isFinite(graceTicks) ? graceTicks : 1;
    const now = (typeof Game !== 'undefined' && Game.time != null) ? Game.time : 0;
    const cutoff = now - g;

    for (const key in root) {
        const entry = root[key];
        if (!entry || entry.version !== 1) continue;
        const meta = entry.meta;
        if (!meta || meta.ownerRoom !== ownerRoom) continue;

        const last = Number.isFinite(meta.lastSeenTick) ? meta.lastSeenTick : -Infinity;
        if (last < cutoff) {
            delete root[key];
        }
    }
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
    touchDuoRuntime,
    gcDuoRuntimesForOwner,
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
