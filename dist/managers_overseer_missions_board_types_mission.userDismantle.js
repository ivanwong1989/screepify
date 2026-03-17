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

function missionName(mission) {
    const suffix = mission.label ? `${mission.id}:${mission.label}` : mission.id;
    return `dismantle:${suffix}`;
}

function isValidTargetPos(pos) {
    if (!pos || !pos.roomName) return false;
    return Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y));
}

function generateDismantleContracts(room, missions) {
    if (!room || !Array.isArray(missions)) return;
    const userDismantleMissions = userMissions.getByType('dismantle');
    if (!Array.isArray(userDismantleMissions) || userDismantleMissions.length <= 0) return;

    for (let i = 0; i < userDismantleMissions.length; i++) {
        const mission = userDismantleMissions[i];
        if (!mission || mission.enabled === false) continue;
        if (mission.sponsorRoom !== room.name) continue;
        if (!isValidTargetPos(mission.targetPos)) continue;

        let targetId = mission.targetId || null;
        if (targetId && !Game.getObjectById(targetId)) {
            const visible = Game.rooms[mission.targetPos.roomName];
            if (visible && mission.persist !== true) {
                userMissions.removeMission(mission.id);
                continue;
            }
            targetId = null;
        }

        missions.push({
            name: missionName(mission),
            type: 'dismantle',
            archetype: 'dismantler',
            requirements: {
                archetype: 'dismantler',
                minCount: 1,
                maxCount: 2
            },
            targetId,
            data: {
                userMissionId: mission.id,
                targetPos: {
                    x: mission.targetPos.x,
                    y: mission.targetPos.y,
                    roomName: mission.targetPos.roomName
                },
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
        const fallback = contract && contract.name ? contract.name : 'dismantle';
        return missionKeys.makeUserMissionKey(roomName, 'userDismantle', userMissionId, fallback);
    },

    reconcileRoom({ room, intel, context, missionBoard }) {
        if (!room || !intel || !missionBoard) return;
        if (!missionThrottle.shouldRunReconcile('userDismantle', room.name, Game.time)) return;
        missionGeneratorBridge.runGeneratorAsTyped({
            room,
            intel,
            context,
            missionBoard,
            namespace: 'userDismantle',
            type: 'userDismantle',
            generate: (scanRoom, scanIntel, scanContext, missions) => generateDismantleContracts(scanRoom, missions),
            mapContract: (contract) => ({
                sponsorRoom: room.name,
                targetRoom: (contract && contract.data && contract.data.targetPos && contract.data.targetPos.roomName) || room.name,
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
            type: 'userDismantle',
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
            demand: { role: 'dismantler', count: 1, bodyProfile: 'dismantler' },
            goal: {
                kind: contract.data && contract.data.persist ? 'service' : 'finite',
                target: {
                    kind: 'user_dismantle',
                    roomName: context.targetRoom || context.sponsorRoom,
                    id: contract.targetId || null
                },
                success: contract.data && contract.data.persist
                    ? { kind: 'user_target_serviced' }
                    : { kind: 'target_destroyed_or_missing' },
                completion: contract.data && contract.data.persist ? 'never' : 'once'
            },
            progress: { stage: 'dismantle', goalState: 'awaiting_assignment' },
            meta: {
                namespace: context.namespace || 'userDismantle',
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
        mission.targetId = contract.targetId || mission.targetId || null;
        mission.meta = mission.meta || {};
        mission.meta.missionName = contract.name || mission.meta.missionName || null;
        mission.meta.persist = !!(contract.data && contract.data.persist);
        mission.demand = {
            role: 'dismantler',
            count: Math.max(0, 1 - mission.assigned.primary.length),
            bodyProfile: 'dismantler'
        };
        mission.progress = mission.progress || {};
        mission.progress.stage = 'dismantle';
        mission.progress.goalState = mission.assigned.primary.length > 0 ? 'executing' : 'awaiting_assignment';
        if (mission.assigned.primary.length > 0) mission.lastProgressTick = Game.time;
    },

    isComplete(mission) {
        if (mission.meta && mission.meta.persist) return false;
        if (!mission.targetId) return false;
        return !Game.getObjectById(mission.targetId);
    },

    toContractMission(mission) {
        const contract = getContract(mission);
        if (!contract) return null;
        return cloneContract(contract);
    }
};



