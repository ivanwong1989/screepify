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
        const fallback = contract && contract.name ? contract.name : 'move2flag';
        return missionKeys.makeUserMissionKey(roomName, 'userRemoteMove2Flag', userMissionId, fallback);
    },

    create(context) {
        const now = Game.time;
        const contract = cloneContract(context.contract) || {};
        const key = this.makeKey(context);
        return {
            id: key,
            key,
            type: 'userRemoteMove2Flag',
            class: missionClasses.SERVICE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.targetRoom || context.sponsorRoom,
            priority: Number.isFinite(contract.priority) ? contract.priority : 50,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: null,
            assigned: { primary: [], support: [] },
            demand: { role: 'move2flag', count: 1, bodyProfile: 'move2flag' },
            goal: {
                kind: 'service',
                target: { kind: 'user_waypoint_route', roomName: context.targetRoom || context.sponsorRoom },
                success: { kind: 'route_serviced' },
                completion: 'never'
            },
            progress: { stage: 'move2flag', goalState: 'awaiting_assignment' },
            meta: {
                namespace: context.namespace || 'userRemoteMove2Flag',
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
        mission.priority = Number.isFinite(contract.priority) ? contract.priority : (mission.priority || 50);
        mission.meta = mission.meta || {};
        mission.meta.legacyName = contract.name || mission.meta.legacyName || null;
        mission.demand = {
            role: 'move2flag',
            count: Math.max(0, 1 - mission.assigned.primary.length),
            bodyProfile: 'move2flag'
        };
        mission.progress = mission.progress || {};
        mission.progress.stage = 'move2flag';
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

