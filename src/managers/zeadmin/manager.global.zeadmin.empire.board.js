const heap = require('utils_heap');

const BOARD_STORE_KEY = 'zeadmin_empire_board';

function ensureStore() {
    const store = heap.getStore(BOARD_STORE_KEY, { ttl: null });
    if (!store.version) store.version = 1;
    if (!store.lastTick) store.lastTick = 0;
    if (!store.missionsById) store.missionsById = Object.create(null);
    if (!store.order) store.order = [];
    if (!store.stats) {
        store.stats = {
            missionCount: 0
        };
    }
    return store;
}

function normalizeMission(mission) {
    if (!mission || !mission.id) return null;
    const now = Game.time;
    return {
        id: String(mission.id),
        scope: 'empire',
        owner: 'zeadmin',
        type: mission.type || 'unknown',
        priority: Number.isFinite(mission.priority) ? mission.priority : 0,
        archetype: mission.archetype || null,
        requirements: mission.requirements || {},
        targetPos: mission.targetPos || null,
        data: mission.data || {},
        sponsorRoom: mission.sponsorRoom || null,
        createdAt: Number.isFinite(mission.createdAt) ? mission.createdAt : now,
        updatedAt: now
    };
}

module.exports = {
    getStore: function() {
        return ensureStore();
    },

    upsert: function(mission) {
        const normalized = normalizeMission(mission);
        if (!normalized) return false;

        const store = ensureStore();
        const existing = store.missionsById[normalized.id];
        if (existing && Number.isFinite(existing.createdAt)) {
            normalized.createdAt = existing.createdAt;
        }

        store.missionsById[normalized.id] = normalized;
        if (store.order.indexOf(normalized.id) === -1) {
            store.order.push(normalized.id);
        }

        store.lastTick = Game.time;
        store.stats.missionCount = store.order.length;
        return true;
    },

    remove: function(missionId) {
        if (!missionId) return false;
        const store = ensureStore();
        const id = String(missionId);
        if (!store.missionsById[id]) return false;
        delete store.missionsById[id];
        store.order = store.order.filter(x => x !== id);
        store.lastTick = Game.time;
        store.stats.missionCount = store.order.length;
        return true;
    },

    list: function() {
        const store = ensureStore();
        const out = [];
        for (let i = 0; i < store.order.length; i++) {
            const id = store.order[i];
            const mission = store.missionsById[id];
            if (mission) out.push(mission);
        }
        out.sort((a, b) => (b.priority || 0) - (a.priority || 0));
        return out;
    },

    clear: function() {
        const store = ensureStore();
        store.missionsById = Object.create(null);
        store.order = [];
        store.lastTick = Game.time;
        store.stats.missionCount = 0;
    }
};

