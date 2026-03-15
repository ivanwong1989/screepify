const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');

function cloneContract(contract) {
    if (!contract || typeof contract !== 'object') return null;
    return Object.assign({}, contract);
}

function getContract(mission) {
    return mission && mission.data ? mission.data.contract : null;
}

function cleanupAssigned(mission) {
    if (!mission.assigned) mission.assigned = { primary: [], support: [] };
    if (!Array.isArray(mission.assigned.primary)) mission.assigned.primary = [];
    mission.assigned.primary = mission.assigned.primary.filter(name => !!Game.creeps[name]);
}

function syncMetaFromContract(mission, contract) {
    mission.priority = Number.isFinite(contract && contract.priority) ? contract.priority : (mission.priority || 60);
    mission.targetId = contract && contract.targetId ? contract.targetId : mission.targetId;
    mission.meta = mission.meta || {};
    mission.meta.userMissionId = mission.meta.userMissionId || (contract && contract.data && contract.data.userMissionId) || null;
    mission.meta.persist = !!(contract && contract.data && contract.data.persist);
    mission.meta.legacyName = contract && contract.name ? contract.name : (mission.meta.legacyName || null);
    mission.meta.resourceType = (contract && contract.data && contract.data.resourceType) || RESOURCE_ENERGY;
}

function getSourceAmount(source, resourceType) {
    if (!source) return 0;
    if (source instanceof Resource) return source.resourceType === resourceType ? source.amount : 0;
    if (source.store) return source.store[resourceType] || 0;
    return 0;
}

function getTargetFree(target, resourceType) {
    if (!target || !target.store || typeof target.store.getFreeCapacity !== 'function') return 0;
    return target.store.getFreeCapacity(resourceType) || 0;
}

module.exports = {
    makeKey(context) {
        const roomName = context.targetRoom || context.sponsorRoom;
        const contract = context.contract || null;
        const userMissionId = context.userMissionId || (contract && contract.data && contract.data.userMissionId) || null;
        const fallback = contract && contract.name ? contract.name : (contract && contract.targetId ? contract.targetId : 'anon');
        return missionKeys.makeUserMissionKey(roomName, 'userTransfer', userMissionId, fallback);
    },

    create(context) {
        const now = Game.time;
        const contract = cloneContract(context.contract) || {};
        const key = this.makeKey(context);
        return {
            id: key,
            key,
            type: 'userTransfer',
            class: missionClasses.FINITE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.targetRoom || context.sponsorRoom,
            priority: Number.isFinite(contract.priority) ? contract.priority : 60,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: contract.targetId || null,
            assigned: { primary: [], support: [] },
            demand: { role: 'user_hauler', count: 1, bodyProfile: 'hauler' },
            goal: {
                kind: contract.data && contract.data.persist ? 'service' : 'finite',
                target: {
                    kind: 'user_transfer',
                    roomName: context.targetRoom || context.sponsorRoom,
                    id: contract.targetId || null
                },
                success: contract.data && contract.data.persist
                    ? { kind: 'user_route_sustained' }
                    : { kind: 'source_drained_or_target_filled' },
                completion: contract.data && contract.data.persist ? 'never' : 'once'
            },
            progress: {
                stage: 'user_transfer',
                goalState: 'awaiting_assignment'
            },
            meta: {
                namespace: context.namespace || 'userTransfer',
                userMissionId: context.userMissionId || (contract.data && contract.data.userMissionId) || null,
                persist: !!(contract.data && contract.data.persist),
                legacyName: contract.name || null,
                resourceType: (contract.data && contract.data.resourceType) || RESOURCE_ENERGY
            },
            data: {
                contract
            },
            statusReason: null
        };
    },

    validate(mission) {
        return !!getContract(mission);
    },

    refresh(mission) {
        cleanupAssigned(mission);
        const contract = getContract(mission);
        if (!contract) return;
        syncMetaFromContract(mission, contract);
        mission.demand = {
            role: 'user_hauler',
            count: Math.max(0, 1 - mission.assigned.primary.length),
            bodyProfile: 'hauler'
        };
        mission.progress = mission.progress || {};
        mission.progress.stage = 'user_transfer';
        mission.progress.goalState = mission.assigned.primary.length > 0 ? 'executing' : 'awaiting_assignment';
    },

    isComplete(mission) {
        const contract = getContract(mission);
        if (!contract) return true;
        if (mission.meta && mission.meta.persist) return false;

        const resourceType = (mission.meta && mission.meta.resourceType) || RESOURCE_ENERGY;
        const sourceId = contract.data && contract.data.sourceId ? contract.data.sourceId : null;
        const targetId = contract.targetId || null;
        const source = sourceId ? Game.getObjectById(sourceId) : null;
        const target = targetId ? Game.getObjectById(targetId) : null;

        if (!source || !target) return false;
        return getSourceAmount(source, resourceType) <= 0 || getTargetFree(target, resourceType) <= 0;
    },

    toLegacyMission(mission) {
        const contract = getContract(mission);
        if (!contract) return null;
        return cloneContract(contract);
    }
};

