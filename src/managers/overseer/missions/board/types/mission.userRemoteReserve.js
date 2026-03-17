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

const RESERVER_COST = 650;

function missionName(mission) {
    const suffix = mission.label ? `${mission.id}:${mission.label}` : mission.id;
    return `reserve:${suffix}`;
}

function targetRoomName(mission) {
    return userMissions.normalizeRoomName(
        (mission && (mission.targetRoom || (mission.targetPos && mission.targetPos.roomName))) || ''
    );
}

function generateReserveContracts(room, missions) {
    if (!room || !Array.isArray(missions)) return;
    const canSpawn = room.energyCapacityAvailable >= RESERVER_COST;
    const userReserveMissions = userMissions.getByType('reserve');
    if (!Array.isArray(userReserveMissions) || userReserveMissions.length <= 0) return;

    for (let i = 0; i < userReserveMissions.length; i++) {
        const mission = userReserveMissions[i];
        if (!mission || mission.enabled === false) continue;
        if (mission.sponsorRoom !== room.name) continue;

        const targetRoom = targetRoomName(mission);
        if (!targetRoom) continue;

        const visible = Game.rooms[targetRoom];
        if (visible && visible.controller) {
            if (visible.controller.owner && !visible.controller.my) {
                if (mission.persist !== true) userMissions.removeMission(mission.id);
                continue;
            }
            if (visible.controller.my) {
                if (mission.persist !== true) userMissions.removeMission(mission.id);
                continue;
            }
        }

        const targetPos = mission.targetPos
            ? { x: mission.targetPos.x, y: mission.targetPos.y, roomName: mission.targetPos.roomName }
            : (visible && visible.controller
                ? { x: visible.controller.pos.x, y: visible.controller.pos.y, roomName: visible.name }
                : { x: 25, y: 25, roomName: targetRoom });

        missions.push({
            name: missionName(mission),
            type: 'remote_reserve',
            archetype: 'reserver',
            requirements: {
                archetype: 'reserver',
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
        const fallback = contract && contract.name ? contract.name : 'reserve';
        return missionKeys.makeUserMissionKey(roomName, 'userRemoteReserve', userMissionId, fallback);
    },

    reconcileRoom({ room, intel, context, missionBoard }) {
        if (!room || !intel || !missionBoard) return;
        if (!missionThrottle.shouldRunReconcile('userRemoteReserve', room.name, Game.time)) return;
        missionGeneratorBridge.runGeneratorAsTyped({
            room,
            intel,
            context,
            missionBoard,
            namespace: 'userRemoteReserve',
            type: 'userRemoteReserve',
            generate: (scanRoom, scanIntel, scanContext, missions) => generateReserveContracts(scanRoom, missions),
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

    toContractMission(mission) {
        const contract = getContract(mission);
        if (!contract) return null;
        return cloneContract(contract);
    }
};



