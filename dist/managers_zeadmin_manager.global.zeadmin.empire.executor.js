const heap = require('utils_heap');
const empireBoard = require('managers_zeadmin_manager.global.zeadmin.empire.board');

const EXEC_STORE_KEY = 'zeadmin_empire_executor';

function ensureStore() {
    const store = heap.getStore(EXEC_STORE_KEY, { ttl: null });
    if (!store.version) store.version = 1;
    if (!store.lastTick) store.lastTick = 0;
    if (!store.lastByCreep) store.lastByCreep = Object.create(null);
    return store;
}

function buildMissionIndex() {
    const index = Object.create(null);
    const missions = empireBoard.list();
    for (let i = 0; i < missions.length; i++) {
        index[missions[i].id] = missions[i];
    }
    return index;
}

function toTaskMove(targetPos, range) {
    if (!targetPos || !targetPos.roomName) return null;
    return {
        action: 'move',
        targetPos: {
            x: targetPos.x,
            y: targetPos.y,
            roomName: targetPos.roomName
        },
        range: Number.isFinite(range) ? range : 1
    };
}

function handleDummy(creep, mission) {
    // Scaffold: move to target flag range 0
    const targetPos = mission && mission.targetPos ? mission.targetPos : (mission.data && mission.data.targetPos);
    return toTaskMove(targetPos, 0);
}

function handleClaimer(creep, mission) {
    // Scaffold: move to target room/controller. Claim intent wiring comes later.
    const targetPos = mission && mission.targetPos ? mission.targetPos : (mission.data && mission.data.targetPos);
    return toTaskMove(targetPos, 1);
}

function handleBuilder(creep, mission) {
    // Scaffold: stage at target position. Real build target selection is deferred.
    const targetPos = mission && mission.targetPos ? mission.targetPos : (mission.data && mission.data.targetPos);
    return toTaskMove(targetPos, 3);
}

function handleAssault(creep, mission) {
    // Scaffold: stage at assault wait/attack position. Tactics integration comes later.
    const data = mission && mission.data ? mission.data : {};
    const targetPos = data.attackPos || data.waitPos || mission.targetPos || null;
    return toTaskMove(targetPos, 1);
}

function dispatch(creep, mission) {
    if (!mission) return null;
    if (mission.type === 'empire_move_flag') return handleDummy(creep, mission);
    if (mission.type === 'remote_claim' || mission.type === 'claimer') return handleClaimer(creep, mission);
    if (mission.type === 'build' || mission.type === 'builder') return handleBuilder(creep, mission);
    if (mission.type === 'assault') return handleAssault(creep, mission);
    return null;
}

module.exports = {
    getStore: function() {
        return ensureStore();
    },

    run: function() {
        const store = ensureStore();
        const byId = buildMissionIndex();
        const creeps = Object.values(Game.creeps);

        for (let i = 0; i < creeps.length; i++) {
            const creep = creeps[i];
            if (!creep || !creep.my || creep.spawning || !creep.memory) continue;
            const missionId = creep.memory.empireMissionId;
            if (!missionId) continue;

            const mission = byId[missionId];
            if (!mission) {
                delete creep.memory.empireMissionId;
                delete creep.memory.empireTaskState;
                delete creep.memory.task;
                continue;
            }

            const task = dispatch(creep, mission);
            if (task) {
                // Reuse existing role runners by publishing legacy `memory.task`.
                creep.memory.task = task;
                store.lastByCreep[creep.name] = {
                    missionId,
                    action: task.action,
                    tick: Game.time
                };
            }
        }

        store.lastTick = Game.time;
        return store;
    }
};
