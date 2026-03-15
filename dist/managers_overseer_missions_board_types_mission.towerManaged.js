const heap = require('utils_heap');
const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const missionTower = require('managers_overseer_missions_board_types_mission.tower');

const TOWER_PLAN_STORE = 'towerManagedPlanByRoom';

function cloneContract(contract) {
    if (!contract || typeof contract !== 'object') return null;
    return Object.assign({}, contract);
}

function getContract(mission) {
    return mission && mission.data ? mission.data.contract : null;
}

function getPolicyName(context) {
    if (!context) return 'tower:defense';
    if (context.policyName) return String(context.policyName);
    if (context.contract && context.contract.name) return String(context.contract.name);
    return 'tower:defense';
}

function getRoomContracts(room, intel, context) {
    if (!room || !intel) return Object.create(null);
    const store = heap.getStore(TOWER_PLAN_STORE, { ttl: 5 });
    if (!store.byRoom) store.byRoom = Object.create(null);
    const cached = store.byRoom[room.name];
    if (cached && cached.tick === Game.time && cached.contractsByName) {
        return cached.contractsByName;
    }

    const generated = [];
    missionTower.generate(room, intel, context || {}, generated);
    const contractsByName = Object.create(null);
    for (let i = 0; i < generated.length; i++) {
        const contract = generated[i];
        if (!contract || !contract.name) continue;
        contractsByName[contract.name] = cloneContract(contract);
    }

    store.byRoom[room.name] = {
        tick: Game.time,
        contractsByName
    };
    return contractsByName;
}

module.exports = {
    makeKey(context) {
        const roomName = context.sponsorRoom || context.targetRoom;
        return missionKeys.makeUserMissionKey(
            roomName,
            'towerManaged',
            getPolicyName(context),
            context.namespace || 'tower'
        );
    },

    create(context) {
        const now = Game.time;
        const contract = cloneContract(context.contract);
        const policyName = getPolicyName(context);
        const key = this.makeKey(context);
        return {
            id: key,
            key,
            type: 'towerManaged',
            class: missionClasses.SERVICE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.targetRoom || context.sponsorRoom,
            priority: Number.isFinite(contract && contract.priority) ? contract.priority : 0,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: contract && contract.targetId ? contract.targetId : null,
            assigned: { primary: [], support: [] },
            demand: null,
            goal: {
                kind: 'service',
                target: { kind: 'tower_policy', roomName: context.sponsorRoom },
                success: { kind: 'tower_contract_active' },
                completion: 'never'
            },
            progress: { stage: 'tower', goalState: 'active' },
            meta: {
                namespace: context.namespace || 'tower',
                policyName,
                contractType: contract && contract.type ? contract.type : null,
                legacyName: policyName
            },
            data: { contract: contract || null },
            statusReason: null
        };
    },

    validate(mission, runtimeCtx) {
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        return !!(room && room.controller && room.controller.my);
    },

    refresh(mission, runtimeCtx) {
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        const intel = runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null;
        const context = runtimeCtx && runtimeCtx.context ? runtimeCtx.context : null;

        mission.meta = mission.meta || {};
        const policyName = mission.meta.policyName || mission.meta.legacyName || 'tower:defense';
        mission.meta.policyName = policyName;
        mission.meta.legacyName = policyName;

        let contract = null;
        if (room && intel) {
            const contractsByName = getRoomContracts(room, intel, context);
            contract = contractsByName[policyName] || null;
        }
        mission.data = mission.data || {};
        mission.data.contract = contract ? cloneContract(contract) : null;

        mission.priority = Number.isFinite(contract && contract.priority)
            ? contract.priority
            : 0;
        mission.targetId = contract && contract.targetId ? contract.targetId : null;
        mission.meta.contractType = contract && contract.type ? contract.type : null;

        mission.progress = mission.progress || {};
        mission.progress.stage = 'tower';
        mission.progress.goalState = contract ? 'active' : 'idle';
        mission.lastProgressTick = Game.time;
    },

    isComplete() {
        return false;
    },

    toLegacyMission(mission) {
        const contract = getContract(mission);
        if (!contract) return null;
        return cloneContract(contract);
    }
};
