const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');
const missionGeneratorBridge = require('managers_overseer_missions_board_utils_missionGeneratorBridge');
const userMissions = require('userMissions');

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

const CLAIMER_COST = 650;

function missionName(mission) {
    const suffix = mission.label ? `${mission.id}:${mission.label}` : mission.id;
    return `claim:${suffix}`;
}

function targetRoomName(mission) {
    return userMissions.normalizeRoomName(
        (mission && (mission.targetRoom || (mission.targetPos && mission.targetPos.roomName))) || ''
    );
}

function generateClaimContracts(room, missions) {
    if (!room || !Array.isArray(missions)) return;
    const canSpawn = room.energyCapacityAvailable >= CLAIMER_COST;
    const userClaimMissions = userMissions.getByType('claim');
    if (!Array.isArray(userClaimMissions) || userClaimMissions.length <= 0) return;

    for (let i = 0; i < userClaimMissions.length; i++) {
        const mission = userClaimMissions[i];
        if (!mission || mission.enabled === false) continue;
        if (mission.sponsorRoom !== room.name) continue;

        const targetRoom = targetRoomName(mission);
        if (!targetRoom) continue;

        const visible = Game.rooms[targetRoom];
        if (visible && visible.controller && visible.controller.my) {
            if (mission.persist !== true) userMissions.removeMission(mission.id);
            continue;
        }

        const targetPos = { x: 25, y: 25, roomName: targetRoom };
        missions.push({
            name: missionName(mission),
            type: 'remote_claim',
            archetype: 'claimer',
            requirements: {
                archetype: 'claimer',
                minCount: 1,
                maxCount: 1,
                spawn: canSpawn
            },
            targetPos,
            data: {
                userMissionId: mission.id,
                targetRoom,
                targetPos,
                persist: mission.persist === true
            },
            priority: Number.isFinite(mission.priority) ? mission.priority : 60
        });
    }
}

module.exports = {
    makeKey(context) {
        const roomName = context.targetRoom || context.sponsorRoom;
        const contract = context.contract || null;
        const userMissionId = context.userMissionId || (contract && contract.data && contract.data.userMissionId) || null;
        const fallback = contract && contract.name ? contract.name : 'claim';
        return missionKeys.makeUserMissionKey(roomName, 'userRemoteClaim', userMissionId, fallback);
    },

    reconcileRoom({ room, intel, context, missionBoard }) {
        if (!room || !intel || !missionBoard) return;
        if (!missionThrottle.shouldRunReconcile('userRemoteClaim', room.name, Game.time)) return;
        missionGeneratorBridge.runGeneratorAsTyped({
            room,
            intel,
            context,
            missionBoard,
            namespace: 'userRemoteClaim',
            type: 'userRemoteClaim',
            generate: (scanRoom, scanIntel, scanContext, missions) => generateClaimContracts(scanRoom, missions),
            mapContract: (contract) => ({
                sponsorRoom: room.name,
                targetRoom: (contract && contract.data && contract.data.targetRoom) || room.name,
                userMissionId: contract && contract.data ? contract.data.userMissionId : null
            })
        });
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
        mission.priority = Number.isFinite(contract.priority) ? contract.priority : (mission.priority || 60);
        mission.meta = mission.meta || {};
        mission.meta.missionName = contract.name || mission.meta.missionName || null;
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

    toContractMission(mission) {
        const contract = getContract(mission);
        if (!contract) return null;
        return cloneContract(contract);
    }
};



