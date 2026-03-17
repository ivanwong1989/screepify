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

function syncContractMeta(mission, contract) {
    mission.priority = Number.isFinite(contract && contract.priority) ? contract.priority : (mission.priority || 0);
    mission.targetId = contract && (contract.targetId || contract.sourceId) ? (contract.targetId || contract.sourceId) : null;
    mission.meta = mission.meta || {};
    mission.meta.contractType = contract && contract.type ? contract.type : (mission.meta.contractType || null);
    mission.meta.contractName = contract && contract.name ? contract.name : (mission.meta.contractName || null);
    if (contract && contract.pos && contract.pos.roomName) {
        mission.targetRoom = contract.pos.roomName;
    }
}

module.exports = {
    makeKey(context) {
        const roomName = context.sponsorRoom || context.targetRoom;
        return missionKeys.makeContractKey(roomName, context.contract);
    },

    create(context) {
        const now = Game.time;
        const contract = cloneContract(context.contract) || {};
        const key = this.makeKey(context);
        const targetRoom = context.targetRoom || context.sponsorRoom;

        return {
            id: key,
            key,
            type: 'contract',
            class: missionClasses.FINITE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom,
            priority: Number.isFinite(contract.priority) ? contract.priority : 0,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: contract.targetId || contract.sourceId || null,
            assigned: { primary: [], support: [] },
            demand: null,
            progress: { stage: 'contract' },
            meta: {
                namespace: context.namespace || null,
                contractType: contract.type || null,
                contractName: contract.name || null
            },
            data: {
                contract
            },
            statusReason: null
        };
    },

    validate(mission) {
        const contract = getContract(mission);
        return !!contract;
    },

    refresh(mission) {
        if (!mission.assigned) mission.assigned = { primary: [], support: [] };
        if (!Array.isArray(mission.assigned.primary)) mission.assigned.primary = [];
        mission.assigned.primary = mission.assigned.primary.filter(name => !!Game.creeps[name]);
        if (mission.assigned.primary.length > 0) mission.lastProgressTick = Game.time;

        const contract = getContract(mission);
        if (!contract) return;
        syncContractMeta(mission, contract);
        mission.progress = mission.progress || {};
        mission.progress.stage = 'contract';
    },

    isComplete() {
        return false;
    },

    toContractMission(mission) {
        const contract = getContract(mission);
        if (!contract) return null;
        return cloneContract(contract);
    }
};

