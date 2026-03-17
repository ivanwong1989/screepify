const heap = require('utils_heap');
const empireBoard = require('managers_zeadmin_manager.global.zeadmin.empire.board');
const empireTasker = require('managers_zeadmin_manager.global.zeadmin.empire.tasker');
const empireExecutor = require('managers_zeadmin_manager.global.zeadmin.empire.executor');
const empireSpawnerInjector = require('managers_zeadmin_manager.global.zeadmin.empire.spawner.injector');
const empireFlagMission = require('managers_zeadmin_manager.global.zeadmin.empire.mission.flag');
const resourceBalancing = require('managers_zeadmin_manager.global.zeadmin.resource.balancing');

const STORE_KEY = 'zeadmin_empire_scaffold';

function ensureStore() {
    const store = heap.getStore(STORE_KEY, { ttl: null });
    if (!store.version) store.version = 1;
    if (!store.lastTick) store.lastTick = 0;
    if (!store.enabled) store.enabled = false;
    return store;
}

module.exports = {
    // Optional switch to keep scaffold inert until explicitly enabled by caller.
    setEnabled: function(enabled) {
        const store = ensureStore();
        store.enabled = !!enabled;
        return store.enabled;
    },

    isEnabled: function() {
        const store = ensureStore();
        return !!store.enabled;
    },

    getStores: function() {
        return {
            scaffold: ensureStore(),
            board: empireBoard.getStore(),
            tasker: empireTasker.getStore(),
            executor: empireExecutor.getStore(),
            spawnerInjector: empireSpawnerInjector.getStore(),
            resourceBalancing: resourceBalancing.getStore()
        };
    },

    run: function() {
        const store = ensureStore();
        if (!store.enabled) return { enabled: false };

        // Seed a tiny baseline mission set from flag inputs.
        const flagSync = empireFlagMission.sync();
        const balanceStore = resourceBalancing.run();

        // 1) Mission board lives in heap and is managed by zeadmin logic.
        // 2) Tasker assigns creeps globally (no room anchor requirement).
        // 3) Executor writes minimal task intents for existing role runners.
        // 4) Spawner injector exposes optional spawn candidates for global spawner integration.
        const taskerStore = empireTasker.run();
        const executorStore = empireExecutor.run();
        const candidates = empireSpawnerInjector.getCandidates();

        store.lastTick = Game.time;
        store.lastSummary = {
            missionCount: empireBoard.list().length,
            candidateCount: candidates.length,
            assignedMissionCount: taskerStore ? Object.keys(taskerStore.runtimeByMissionId || {}).length : 0,
            executedCreepCount: executorStore ? Object.keys(executorStore.lastByCreep || {}).length : 0,
            flagSync,
            resourceBalancing: balanceStore && balanceStore.lastSummary ? balanceStore.lastSummary : null
        };

        return {
            enabled: true,
            summary: store.lastSummary,
            candidates
        };
    }
};
