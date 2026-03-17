const heap = require('utils_heap');
const empireBoard = require('managers_zeadmin_manager.global.zeadmin.empire.board');
const empireTasker = require('managers_zeadmin_manager.global.zeadmin.empire.tasker');

const INJECT_STORE_KEY = 'zeadmin_empire_spawner_injector';

function ensureStore() {
    const store = heap.getStore(INJECT_STORE_KEY, { ttl: null });
    if (!store.version) store.version = 1;
    if (!store.lastTick) store.lastTick = 0;
    if (!store.lastCandidates) store.lastCandidates = [];
    if (!store.pendingByMissionId) store.pendingByMissionId = Object.create(null);
    return store;
}

function countAssignedForMission(taskerStore, missionId) {
    if (!taskerStore || !taskerStore.runtimeByMissionId) return 0;
    const runtime = taskerStore.runtimeByMissionId[missionId];
    if (!runtime || !Array.isArray(runtime.assigned)) return 0;
    return runtime.assigned.length;
}

function resolveDesired(mission) {
    const req = mission && mission.requirements ? mission.requirements : {};
    if (Number.isFinite(req.maxCount)) return Math.max(0, req.maxCount);
    if (Number.isFinite(req.minCount)) return Math.max(0, req.minCount);
    return 1;
}

function sanitizeTag(raw, fallback) {
    const s = String(raw || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (s.length > 0) return s.slice(0, 24);
    return fallback || 'mission';
}

function buildCandidate(mission, idx) {
    const role = mission.archetype || (mission.requirements && mission.requirements.archetype) || 'worker';
    const missionId = mission.id;
    const bindId = missionId;
    const tagRaw = (mission.data && mission.data.flagName) ? `flag_${mission.data.flagName}` : missionId;
    const missionTag = sanitizeTag(tagRaw, 'mission');
    const body = [MOVE];
    const cost = 50;
    const sponsorRoom = mission.sponsorRoom;

    return {
        contractId: `home=${sponsorRoom}|role=${role}|bind=empire:${bindId}`,
        homeRoom: sponsorRoom,
        role,
        bindMode: 'empire',
        bindId,
        priority: Number.isFinite(mission.priority) ? mission.priority : 0,
        namePrefix: `emp-r-${role}-m-${missionTag}`,
        body,
        cost,
        memory: {
            role,
            room: sponsorRoom,
            taskState: 'init',
            contractId: `home=${sponsorRoom}|role=${role}|bind=empire:${bindId}`,
            bindMode: 'empire',
            bindId,
            empireMissionId: missionId,
            empireTag: missionTag
        },
        targetRoom: mission.data && mission.data.targetRoom ? mission.data.targetRoom : null,
        _empireScaffold: true,
        _idx: idx
    };
}

module.exports = {
    getStore: function() {
        return ensureStore();
    },

    getCandidates: function() {
        const store = ensureStore();
        const taskerStore = empireTasker.getStore();
        const missions = empireBoard.list();
        const out = [];

        for (const missionId in store.pendingByMissionId) {
            if ((store.pendingByMissionId[missionId] || 0) <= Game.time) {
                delete store.pendingByMissionId[missionId];
            }
        }

        for (let i = 0; i < missions.length; i++) {
            const mission = missions[i];
            if (!mission || !mission.requirements) continue;
            if (mission.requirements.spawn === false) continue;
            if (!mission.sponsorRoom || !Game.rooms[mission.sponsorRoom]) continue;

            const desired = resolveDesired(mission);
            const assigned = countAssignedForMission(taskerStore, mission.id);
            const deficit = Math.max(0, desired - assigned);
            if (deficit <= 0) continue;
            if (store.pendingByMissionId[mission.id]) continue;

            for (let k = 0; k < deficit; k++) {
                out.push(buildCandidate(mission, k));
            }
            store.pendingByMissionId[mission.id] = Game.time + 20;
        }

        store.lastTick = Game.time;
        store.lastCandidates = out;
        return out;
    }
};
