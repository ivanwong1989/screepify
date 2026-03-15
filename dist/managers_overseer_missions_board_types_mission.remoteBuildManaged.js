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
        const roomName = context.sponsorRoom || context.targetRoom;
        return missionKeys.makeUserMissionKey(
            roomName,
            'remoteBuildManaged',
            context.contract && context.contract.name ? context.contract.name : null,
            context.namespace || 'remoteBuild'
        );
    },

    create(context) {
        const now = Game.time;
        const contract = cloneContract(context.contract) || {};
        const key = this.makeKey(context);
        return {
            id: key,
            key,
            type: 'remoteBuildManaged',
            class: missionClasses.FINITE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.targetRoom || context.sponsorRoom,
            priority: Number.isFinite(contract.priority) ? contract.priority : 55,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: contract.targetId || null,
            assigned: { primary: [], support: [] },
            demand: null,
            goal: {
                kind: 'finite',
                target: { kind: 'remote_build_contract', roomName: context.targetRoom || context.sponsorRoom },
                success: { kind: 'site_built_or_contract_replaced' }
            },
            progress: { stage: 'remote_build', goalState: 'awaiting_assignment' },
            meta: {
                namespace: context.namespace || 'remoteBuild',
                contractType: contract.type || null,
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
        mission.priority = Number.isFinite(contract.priority) ? contract.priority : (mission.priority || 55);
        mission.targetId = contract.targetId || mission.targetId || null;
        mission.meta = mission.meta || {};
        mission.meta.contractType = contract.type || mission.meta.contractType || null;
        mission.meta.legacyName = contract.name || mission.meta.legacyName || null;
        mission.progress = mission.progress || {};
        mission.progress.stage = 'remote_build';
        mission.progress.goalState = mission.assigned.primary.length > 0 ? 'executing' : 'awaiting_assignment';
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

