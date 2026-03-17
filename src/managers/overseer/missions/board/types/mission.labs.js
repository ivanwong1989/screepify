const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');
const missionGeneratorBridge = require('managers_overseer_missions_board_utils_missionGeneratorBridge');
const managerLabs = require('managers_structures_manager.labs');

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

function generateLabsContracts(room, missions) {
    if (!room || !Array.isArray(missions)) return;
    const labMissions = managerLabs.getLogisticsMissions(room);
    if (!Array.isArray(labMissions) || labMissions.length <= 0) return;
    for (let i = 0; i < labMissions.length; i++) {
        const contract = labMissions[i];
        if (!contract) continue;
        missions.push(contract);
    }
}

module.exports = {
    makeKey(context) {
        const roomName = context.sponsorRoom || context.targetRoom;
        return missionKeys.makeUserMissionKey(
            roomName,
            'labs',
            context.contract && context.contract.name ? context.contract.name : null,
            context.namespace || 'labs'
        );
    },

    reconcileRoom({ room, intel, context, missionBoard }) {
        if (!room || !intel || !missionBoard) return;
        if (!missionThrottle.shouldRunReconcile('labs', room.name, Game.time)) return;
        missionGeneratorBridge.runGeneratorAsTyped({
            room,
            intel,
            context,
            missionBoard,
            namespace: 'labs',
            type: 'labs',
            generate: (scanRoom, scanIntel, scanContext, missions) => generateLabsContracts(scanRoom, missions),
            mapContract: () => ({ sponsorRoom: room.name, targetRoom: room.name })
        });
    },

    create(context) {
        const now = Game.time;
        const contract = cloneContract(context.contract) || {};
        const key = this.makeKey(context);
        return {
            id: key,
            key,
            type: 'labs',
            class: missionClasses.FINITE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.targetRoom || context.sponsorRoom,
            priority: Number.isFinite(contract.priority) ? contract.priority : 0,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: contract.targetId || null,
            assigned: { primary: [], support: [] },
            demand: null,
            goal: {
                kind: 'finite',
                target: { kind: 'labs_contract', roomName: context.sponsorRoom },
                success: { kind: 'contract_completed_or_replaced' }
            },
            progress: { stage: 'labs', goalState: 'awaiting_assignment' },
            meta: {
                namespace: context.namespace || 'labs',
                contractType: contract.type || null,
                missionName: contract.name || null
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
        mission.priority = Number.isFinite(contract.priority) ? contract.priority : (mission.priority || 0);
        mission.meta = mission.meta || {};
        mission.meta.contractType = contract.type || mission.meta.contractType || null;
        mission.meta.missionName = contract.name || mission.meta.missionName || null;
        mission.progress = mission.progress || {};
        mission.progress.stage = 'labs';
        mission.progress.goalState = mission.assigned.primary.length > 0 ? 'executing' : 'awaiting_assignment';
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
