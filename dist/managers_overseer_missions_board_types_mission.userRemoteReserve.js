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

module.exports = {
    makeKey(context) {
        const roomName = context.targetRoom || context.sponsorRoom;
        const contract = context.contract || null;
        const userMissionId = context.userMissionId || (contract && contract.data && contract.data.userMissionId) || null;
        const fallback = contract && contract.name ? contract.name : 'reserve';
        return missionKeys.makeUserMissionKey(roomName, 'userRemoteReserve', userMissionId, fallback);
    },

    create(context) {
        const now = Game.time;
        const contract = cloneContract(context.contract) || {};
        const key = this.makeKey(context);
        return {
            id: key,
            key,
            type: 'userRemoteReserve',
            class: missionClasses.SERVICE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.targetRoom || context.sponsorRoom,
            priority: Number.isFinite(contract.priority) ? contract.priority : 60,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: null,
            assigned: { primary: [], support: [] },
            demand: { role: 'reserver', count: 1, bodyProfile: 'reserver' },
            goal: {
                kind: 'service',
                target: { kind: 'user_remote_reserve', roomName: context.targetRoom || context.sponsorRoom },
                success: { kind: 'reservation_sustained' },
                completion: 'never'
            },
            progress: { stage: 'reserve', goalState: 'awaiting_assignment' },
            meta: {
                namespace: context.namespace || 'userRemoteReserve',
                userMissionId: context.userMissionId || (contract.data && contract.data.userMissionId) || null,
                legacyName: contract.name || null
            },
            data: { contract },
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
        mission.priority = Number.isFinite(contract.priority) ? contract.priority : (mission.priority || 60);
        mission.meta = mission.meta || {};
        mission.meta.legacyName = contract.name || mission.meta.legacyName || null;
        mission.demand = {
            role: 'reserver',
            count: Math.max(0, 1 - mission.assigned.primary.length),
            bodyProfile: 'reserver'
        };
        mission.progress = mission.progress || {};
        mission.progress.stage = 'reserve';
        mission.progress.goalState = mission.assigned.primary.length > 0 ? 'executing' : 'awaiting_assignment';
        if (mission.assigned.primary.length > 0) mission.lastProgressTick = Game.time;
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

