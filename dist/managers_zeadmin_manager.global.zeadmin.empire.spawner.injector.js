const heap = require('utils_heap');
const bodyCodec = require('utils_bodyCodec');
const empireBoard = require('managers_zeadmin_manager.global.zeadmin.empire.board');
const empireTasker = require('managers_zeadmin_manager.global.zeadmin.empire.tasker');

const INJECT_STORE_KEY = 'zeadmin_empire_spawner_injector';

function ensureStore() {
    const store = heap.getStore(INJECT_STORE_KEY, { ttl: null });
    if (!store.version) store.version = 1;
    if (!store.lastTick) store.lastTick = 0;
    if (!store.lastTickets) store.lastTickets = [];
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

function buildMinimalTicket(mission, idx) {
    const role = mission.archetype || (mission.requirements && mission.requirements.archetype) || 'worker';
    const missionId = mission.id;
    const bindId = missionId;
    const ticketId = `empire:${missionId}:${Game.time}:${idx}`;
    const tagRaw = (mission.data && mission.data.flagName) ? `flag_${mission.data.flagName}` : missionId;
    const missionTag = sanitizeTag(tagRaw, 'mission');
    const bodyParts = [MOVE];
    const cost = 50;

    return {
        ticketId,
        contractId: `home=empire|role=${role}|bind=empire:${bindId}`,
        homeRoom: mission.sponsorRoom,
        role,
        bindMode: 'empire',
        bindId,
        priority: Number.isFinite(mission.priority) ? mission.priority : 0,
        namePrefix: `emp-r-${role}-m-${missionTag}`,
        body: bodyCodec.encodeBody(bodyParts),
        cost,
        memory: {
            role,
            empireMissionId: missionId,
            empireTag: missionTag
        },
        targetRoom: mission.data && mission.data.targetRoom ? mission.data.targetRoom : null,
        _empireScaffold: true
    };
}

module.exports = {
    getStore: function() {
        return ensureStore();
    },

    getTickets: function() {
        const store = ensureStore();
        const taskerStore = empireTasker.getStore();
        const missions = empireBoard.list();
        const out = [];

        // Clear stale pending throttles.
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
                out.push(buildMinimalTicket(mission, k));
            }
            // Simple scaffold guard: avoid duplicate requests while spawn is in progress.
            store.pendingByMissionId[mission.id] = Game.time + 20;
        }

        store.lastTick = Game.time;
        store.lastTickets = out;
        return out;
    },

    // Use this helper when wiring into existing main loop:
    // allSpawnTickets = injector.appendToGlobalTickets(allSpawnTickets)
    appendToGlobalTickets: function(existingTickets) {
        const base = Array.isArray(existingTickets) ? existingTickets : [];
        const injected = this.getTickets();
        if (!injected || injected.length === 0) return base;
        return base.concat(injected);
    }
};
