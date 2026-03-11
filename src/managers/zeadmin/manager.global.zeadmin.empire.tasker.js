const heap = require('utils_heap');
const empireBoard = require('managers_zeadmin_manager.global.zeadmin.empire.board');

const TASKER_STORE_KEY = 'zeadmin_empire_tasker';

function ensureStore() {
    const store = heap.getStore(TASKER_STORE_KEY, { ttl: null });
    if (!store.version) store.version = 1;
    if (!store.lastTick) store.lastTick = 0;
    if (!store.runtimeByMissionId) store.runtimeByMissionId = Object.create(null);
    if (!store.creepToMission) store.creepToMission = Object.create(null);
    return store;
}

function getMissionDesiredCount(mission) {
    const req = mission && mission.requirements ? mission.requirements : {};
    if (Number.isFinite(req.maxCount)) return Math.max(0, req.maxCount);
    if (Number.isFinite(req.minCount)) return Math.max(0, req.minCount);
    return 1;
}

function isCreepEligible(creep, mission) {
    if (!creep || !creep.my || creep.spawning) return false;
    if (!mission) return false;
    if (mission.archetype && creep.memory && creep.memory.role !== mission.archetype) return false;
    return true;
}

function sanitizeTag(raw, fallback) {
    const s = String(raw || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (s.length > 0) return s.slice(0, 24);
    return fallback || 'mission';
}

function parseEmpireIdentityFromName(name) {
    if (!name || typeof name !== 'string') return null;
    // Format from empire injector:
    // emp-r-<role>-m-<tag>_<time36>_<rand>
    const m = name.match(/^emp-r-([a-z0-9_]+)-m-([a-z0-9_]+)_/i);
    if (!m) return null;
    return {
        role: m[1],
        tag: m[2]
    };
}

function buildMissionIndexByTag(missions) {
    const byTag = Object.create(null);
    for (let i = 0; i < missions.length; i++) {
        const mission = missions[i];
        if (!mission || !mission.id) continue;
        const fromFlag = mission.data && mission.data.flagName ? `flag_${mission.data.flagName}` : null;
        const primaryTag = sanitizeTag(fromFlag || mission.id, 'mission');
        if (!byTag[primaryTag]) byTag[primaryTag] = mission;
    }
    return byTag;
}

function clearEmpireAssignment(creep, store) {
    if (!creep || !creep.memory) return;
    const missionId = creep.memory.empireMissionId;
    if (missionId && store && store.runtimeByMissionId[missionId]) {
        const runtime = store.runtimeByMissionId[missionId];
        runtime.assigned = (runtime.assigned || []).filter(name => name !== creep.name);
    }
    delete creep.memory.empireMissionId;
    delete creep.memory.empireTaskState;
}

module.exports = {
    getStore: function() {
        return ensureStore();
    },

    run: function() {
        const store = ensureStore();
        const missions = empireBoard.list();
        const missionByTag = buildMissionIndexByTag(missions);

        // Keep runtimes in heap only; no runtime mission board state in Memory.
        const missionIds = new Set();
        for (let i = 0; i < missions.length; i++) {
            const mission = missions[i];
            missionIds.add(mission.id);
            if (!store.runtimeByMissionId[mission.id]) {
                store.runtimeByMissionId[mission.id] = {
                    assigned: [],
                    stage: 'INIT',
                    createdAt: Game.time,
                    updatedAt: Game.time
                };
            }
        }

        // Remove stale mission runtimes and creep links.
        for (const missionId in store.runtimeByMissionId) {
            if (!missionIds.has(missionId)) {
                delete store.runtimeByMissionId[missionId];
            }
        }

        const creeps = Object.values(Game.creeps);

        // Recover wiped/empty memory from empire naming convention.
        for (let i = 0; i < creeps.length; i++) {
            const creep = creeps[i];
            if (!creep || !creep.my || !creep.memory) continue;

            const identity = parseEmpireIdentityFromName(creep.name);
            if (!identity) continue;

            // Role recovery for no-room shards where memory may be blank.
            if (!creep.memory.role) {
                creep.memory.role = identity.role;
            }

            if (!creep.memory.empireTag) {
                creep.memory.empireTag = identity.tag;
            }

            if (!creep.memory.empireMissionId && missionByTag[identity.tag]) {
                creep.memory.empireMissionId = missionByTag[identity.tag].id;
                creep.memory.empireTaskState = 'init';
            }
        }

        // Clean stale creep assignments first.
        for (let i = 0; i < creeps.length; i++) {
            const creep = creeps[i];
            if (!creep || !creep.my || !creep.memory) continue;
            const missionId = creep.memory.empireMissionId;
            if (!missionId) continue;
            if (!missionIds.has(missionId)) {
                clearEmpireAssignment(creep, store);
            }
        }

        // Rebuild assignment tables from live creeps.
        for (const missionId in store.runtimeByMissionId) {
            store.runtimeByMissionId[missionId].assigned = [];
        }
        store.creepToMission = Object.create(null);
        for (let i = 0; i < creeps.length; i++) {
            const creep = creeps[i];
            if (!creep || !creep.my || !creep.memory) continue;
            const missionId = creep.memory.empireMissionId;
            if (!missionId || !store.runtimeByMissionId[missionId]) continue;
            store.runtimeByMissionId[missionId].assigned.push(creep.name);
            store.creepToMission[creep.name] = missionId;
        }

        // Greedy fill by mission priority.
        for (let i = 0; i < missions.length; i++) {
            const mission = missions[i];
            const runtime = store.runtimeByMissionId[mission.id];
            const desired = getMissionDesiredCount(mission);
            const assignedNow = runtime.assigned ? runtime.assigned.length : 0;
            let need = Math.max(0, desired - assignedNow);
            if (need <= 0) continue;

            for (let c = 0; c < creeps.length && need > 0; c++) {
                const creep = creeps[c];
                if (!isCreepEligible(creep, mission)) continue;
                if (creep.memory.empireMissionId) continue;

                creep.memory.empireMissionId = mission.id;
                creep.memory.empireTaskState = 'init';

                runtime.assigned.push(creep.name);
                store.creepToMission[creep.name] = mission.id;
                need -= 1;
            }

            runtime.updatedAt = Game.time;
        }

        store.lastTick = Game.time;
        return store;
    },

    unassignCreep: function(creepName) {
        if (!creepName) return false;
        const creep = Game.creeps[creepName];
        const store = ensureStore();
        if (!creep || !creep.memory || !creep.memory.empireMissionId) return false;
        clearEmpireAssignment(creep, store);
        delete store.creepToMission[creepName];
        store.lastTick = Game.time;
        return true;
    }
};
