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

function getTargetRoom(contract) {
    if (!contract) return null;
    if (contract.data && contract.data.targetRoom) return contract.data.targetRoom;
    if (contract.targetPos && contract.targetPos.roomName) return contract.targetPos.roomName;
    return null;
}

module.exports = {
    makeKey(context) {
        const roomName = context.targetRoom || context.sponsorRoom;
        const contract = context.contract || null;
        const userMissionId = context.userMissionId || (contract && contract.data && contract.data.userMissionId) || null;
        const fallback = contract && contract.name ? contract.name : 'claim';
        return missionKeys.makeUserMissionKey(roomName, 'userRemoteClaim', userMissionId, fallback);
    },

    create(context) {
        const now = Game.time;
        const contract = cloneContract(context.contract) || {};
        const key = this.makeKey(context);
        return {
            id: key,
            key,
            type: 'userRemoteClaim',
            class: missionClasses.FINITE,
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
            demand: { role: 'claimer', count: 1, bodyProfile: 'claimer' },
            goal: {
                kind: 'finite',
                target: { kind: 'user_remote_claim', roomName: context.targetRoom || context.sponsorRoom },
                success: { kind: 'room_claimed' }
            },
            progress: { stage: 'claim', goalState: 'awaiting_assignment' },
            meta: {
                namespace: context.namespace || 'userRemoteClaim',
                userMissionId: context.userMissionId || (contract.data && contract.data.userMissionId) || null,
                persist: !!(contract.data && contract.data.persist),
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
        mission.meta.persist = !!(contract.data && contract.data.persist);
        mission.demand = {
            role: 'claimer',
            count: Math.max(0, 1 - mission.assigned.primary.length),
            bodyProfile: 'claimer'
        };
        mission.progress = mission.progress || {};
        mission.progress.stage = 'claim';
        mission.progress.goalState = mission.assigned.primary.length > 0 ? 'executing' : 'awaiting_assignment';
        if (mission.assigned.primary.length > 0) mission.lastProgressTick = Game.time;
    },

    isComplete(mission) {
        if (mission.meta && mission.meta.persist) return false;
        const contract = getContract(mission);
        if (!contract) return true;
        const targetRoom = getTargetRoom(contract);
        if (!targetRoom || !Game.rooms[targetRoom] || !Game.rooms[targetRoom].controller) return false;
        return !!Game.rooms[targetRoom].controller.my;
    },

    toLegacyMission(mission) {
        const contract = getContract(mission);
        if (!contract) return null;
        return cloneContract(contract);
    }
};

