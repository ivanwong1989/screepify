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

function syncMetaFromContract(mission, contract) {
    mission.priority = Number.isFinite(contract && contract.priority) ? contract.priority : (mission.priority || 60);
    mission.targetId = contract && contract.targetId ? contract.targetId : mission.targetId;
    mission.meta = mission.meta || {};
    mission.meta.userMissionId = mission.meta.userMissionId || (contract && contract.data && contract.data.userMissionId) || null;
    mission.meta.persist = !!(contract && contract.data && contract.data.persist);
    mission.meta.missionName = contract && contract.name ? contract.name : (mission.meta.missionName || null);
    mission.meta.resourceType = (contract && contract.data && contract.data.resourceType) || RESOURCE_ENERGY;
}

function getSourceAmount(source, resourceType) {
    if (!source) return 0;
    if (source instanceof Resource) return source.resourceType === resourceType ? source.amount : 0;
    if (source.store) return source.store[resourceType] || 0;
    return 0;
}

function getTargetFree(target, resourceType) {
    if (!target || !target.store || typeof target.store.getFreeCapacity !== 'function') return 0;
    return target.store.getFreeCapacity(resourceType) || 0;
}

function missionName(mission) {
    const suffix = mission.label ? `${mission.id}:${mission.label}` : mission.id;
    return `userhaul:${suffix}`;
}

function normalizeId(value) {
    if (value === undefined || value === null) return '';
    return ('' + value).trim();
}

function normalizeResourceType(value) {
    if (value === undefined || value === null || value === '') return RESOURCE_ENERGY;
    return ('' + value).trim();
}

function generateUserTransferContracts(room, missions) {
    if (!room || !Array.isArray(missions)) return;
    const userTransferMissions = userMissions.getByType('transfer');
    if (!Array.isArray(userTransferMissions) || userTransferMissions.length <= 0) return;

    for (let i = 0; i < userTransferMissions.length; i++) {
        const mission = userTransferMissions[i];
        if (!mission || mission.enabled === false) continue;
        if (mission.sponsorRoom !== room.name) continue;

        const sourceId = normalizeId(mission.sourceId);
        const targetId = normalizeId(mission.targetId);
        if (!sourceId || !targetId) continue;

        const source = Game.getObjectById(sourceId);
        const target = Game.getObjectById(targetId);
        if ((!source || !target) && mission.persist !== true && Game.rooms[room.name]) {
            userMissions.removeMission(mission.id);
            continue;
        }
        if (!source || !target) continue;

        const resourceType = normalizeResourceType(mission.resourceType);
        const sourceAmount = getSourceAmount(source, resourceType);
        const targetFree = getTargetFree(target, resourceType);
        if ((sourceAmount <= 0 || targetFree <= 0) && mission.persist !== true) {
            userMissions.removeMission(mission.id);
            continue;
        }
        if (targetFree <= 0) continue;
        if (sourceAmount <= 0 && mission.persist !== true) continue;

        const targetRoom = userMissions.normalizeRoomName(mission.targetRoom);
        const sourceRoom = userMissions.normalizeRoomName(mission.sourceRoom);
        const remoteRoom = (targetRoom && targetRoom !== room.name)
            ? targetRoom
            : ((sourceRoom && sourceRoom !== room.name) ? sourceRoom : null);
        const count = Number(mission.count);

        missions.push({
            name: missionName(mission),
            type: 'transfer',
            archetype: 'user_hauler',
            requirements: {
                archetype: 'user_hauler',
                minCount: 1,
                maxCount: Number.isFinite(count) && count >= 1 ? Math.floor(count) : 1,
                spawn: true
            },
            targetId,
            data: {
                userMissionId: mission.id,
                sourceId,
                resourceType,
                persist: mission.persist === true,
                targetRoom: remoteRoom
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
        const fallback = contract && contract.name ? contract.name : (contract && contract.targetId ? contract.targetId : 'anon');
        return missionKeys.makeUserMissionKey(roomName, 'userTransfer', userMissionId, fallback);
    },

    reconcileRoom({ room, intel, context, missionBoard }) {
        if (!room || !intel || !missionBoard) return;
        if (!missionThrottle.shouldRunReconcile('userTransfer', room.name, Game.time)) return;
        missionGeneratorBridge.runGeneratorAsTyped({
            room,
            intel,
            context,
            missionBoard,
            namespace: 'userTransfer',
            type: 'userTransfer',
            generate: (scanRoom, scanIntel, scanContext, missions) => generateUserTransferContracts(scanRoom, missions),
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
            type: 'userTransfer',
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
            demand: { role: 'user_hauler', count: 1, bodyProfile: 'hauler' },
            goal: {
                kind: contract.data && contract.data.persist ? 'service' : 'finite',
                target: {
                    kind: 'user_transfer',
                    roomName: context.targetRoom || context.sponsorRoom,
                    id: contract.targetId || null
                },
                success: contract.data && contract.data.persist
                    ? { kind: 'user_route_sustained' }
                    : { kind: 'source_drained_or_target_filled' },
                completion: contract.data && contract.data.persist ? 'never' : 'once'
            },
            progress: {
                stage: 'user_transfer',
                goalState: 'awaiting_assignment'
            },
            meta: {
                namespace: context.namespace || 'userTransfer',
                userMissionId: context.userMissionId || (contract.data && contract.data.userMissionId) || null,
                persist: !!(contract.data && contract.data.persist),
                missionName: contract.name || null,
                resourceType: (contract.data && contract.data.resourceType) || RESOURCE_ENERGY
            },
            data: {
                contract
            },
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
        syncMetaFromContract(mission, contract);
        mission.demand = {
            role: 'user_hauler',
            count: Math.max(0, 1 - mission.assigned.primary.length),
            bodyProfile: 'hauler'
        };
        mission.progress = mission.progress || {};
        mission.progress.stage = 'user_transfer';
        mission.progress.goalState = mission.assigned.primary.length > 0 ? 'executing' : 'awaiting_assignment';
    },

    isComplete(mission) {
        const contract = getContract(mission);
        if (!contract) return true;
        if (mission.meta && mission.meta.persist) return false;

        const resourceType = (mission.meta && mission.meta.resourceType) || RESOURCE_ENERGY;
        const sourceId = contract.data && contract.data.sourceId ? contract.data.sourceId : null;
        const targetId = contract.targetId || null;
        const source = sourceId ? Game.getObjectById(sourceId) : null;
        const target = targetId ? Game.getObjectById(targetId) : null;

        if (!source || !target) return false;
        return getSourceAmount(source, resourceType) <= 0 || getTargetFree(target, resourceType) <= 0;
    },

    toContractMission(mission) {
        const contract = getContract(mission);
        if (!contract) return null;
        return cloneContract(contract);
    }
};



