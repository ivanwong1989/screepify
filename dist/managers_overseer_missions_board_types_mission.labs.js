const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');
const missionGeneratorBridge = require('managers_overseer_missions_board_utils_missionGeneratorBridge');

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
    if (!Array.isArray(mission.assigned.support)) mission.assigned.support = [];
    mission.assigned.primary = mission.assigned.primary.filter(name => !!Game.creeps[name]);
    mission.assigned.support = mission.assigned.support.filter(name => !!Game.creeps[name]);
}

function generateLabsContracts(room, missions) {
    if (!room || !Array.isArray(missions)) return;
    // Deprecated path: standalone lab logistics contracts are now serviced by logisticsCoreV2
    // through managerLabs.getLogisticsNeeds(). Keep this generator empty so namespace
    // reconciliation cancels any legacy labs missions still present on the board.
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

    validate(mission, runtimeCtx) {
        return !!getContract(mission);
    },

    refresh(mission, runtimeCtx) {
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
        // Deprecated: prevent publishing direct lab logistics contracts to task assignment.
        return null;
    }
};
