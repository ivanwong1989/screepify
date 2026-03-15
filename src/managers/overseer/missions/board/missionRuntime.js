function ensureRuntime() {
    if (!global.__missionRuntime || typeof global.__missionRuntime !== 'object') {
        global.__missionRuntime = {
            byId: {},
            roomContext: {},
            roomScanCache: {},
            pathCache: {}
        };
    }
    return global.__missionRuntime;
}

function setRoomContext(roomName, context) {
    if (!roomName) return;
    const runtime = ensureRuntime();
    runtime.roomContext[roomName] = {
        tick: Game.time,
        context: context || {}
    };
}

function getRoomContext(roomName) {
    if (!roomName) return null;
    const runtime = ensureRuntime();
    const entry = runtime.roomContext[roomName];
    if (!entry || entry.tick !== Game.time) return null;
    return entry.context || null;
}

function getMissionRuntime(mission) {
    const runtime = ensureRuntime();
    const byId = runtime.byId;
    if (!byId[mission.id]) {
        byId[mission.id] = {
            createdTick: Game.time
        };
    }
    return byId[mission.id];
}

function deleteMissionRuntime(id) {
    const runtime = ensureRuntime();
    if (runtime.byId && runtime.byId[id]) delete runtime.byId[id];
}

module.exports = {
    ensureRuntime,
    setRoomContext,
    getRoomContext,
    getMissionRuntime,
    deleteMissionRuntime
};

