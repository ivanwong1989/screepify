const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const remoteUtils = require('managers_overseer_utils_overseer.remote');
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
    mission.assigned.primary = mission.assigned.primary.filter(name => !!Game.creeps[name]);
}

const MAX_REMOTE_BUILD_SITES_PER_ROOM = 3;

function getLiveRemoteBuildContractsByRoom(room, missionBoard) {
    const byRoom = Object.create(null);
    if (!room || !missionBoard) return byRoom;
    const live = missionBoard.listLiveByRoom(room.name);
    for (let i = 0; i < live.length; i++) {
        const mission = live[i];
        if (!mission || mission.type !== 'remoteBuild') continue;
        const contract = mission.data && mission.data.contract ? mission.data.contract : null;
        if (!contract) continue;
        const remoteRoom = (contract.data && contract.data.remoteRoom)
            || (contract.targetPos && contract.targetPos.roomName)
            || mission.targetRoom
            || null;
        if (!remoteRoom) continue;
        if (!byRoom[remoteRoom]) byRoom[remoteRoom] = [];
        byRoom[remoteRoom].push(contract);
    }
    return byRoom;
}

function generateRemoteBuildContracts(room, context, missionBoard, contracts) {
    if (!room || !Array.isArray(contracts) || !missionBoard) return;
    const entries = remoteUtils.getRemoteEconomicContext(room, {
        opState: context && context.opState ? context.opState : null,
        maxScoutAge: 4000
    });
    const liveByRoom = getLiveRemoteBuildContractsByRoom(room, missionBoard);

    for (let i = 0; i < entries.length; i++) {
        const wrapped = entries[i];
        const remoteRoom = wrapped && wrapped.name ? wrapped.name : null;
        if (!remoteRoom || !wrapped || !wrapped.enabled) continue;

        const remote = wrapped.room || null;
        if (!remote) {
            const existing = liveByRoom[remoteRoom] || [];
            for (let j = 0; j < existing.length; j++) {
                const retained = cloneContract(existing[j]);
                if (retained) contracts.push(retained);
            }
            continue;
        }

        const sites = remote.find(FIND_MY_CONSTRUCTION_SITES);
        if (!sites || sites.length <= 0) continue;

        const sourcesInfo = wrapped.entry && Array.isArray(wrapped.entry.sourcesInfo) ? wrapped.entry.sourcesInfo : [];
        const sourceIds = sourcesInfo.map(s => s && s.id).filter(Boolean);
        const containerIds = sourcesInfo.map(s => s && s.containerId).filter(Boolean);
        const capped = sites.slice(0, MAX_REMOTE_BUILD_SITES_PER_ROOM);

        for (let j = 0; j < capped.length; j++) {
            const site = capped[j];
            if (!site || !site.id || !site.pos) continue;
            contracts.push({
                name: `remoteBuild:${remoteRoom}:${site.id}`,
                type: 'remote_build',
                archetype: 'remote_worker',
                requirements: {
                    archetype: 'remote_worker',
                    minCount: 1,
                    maxCount: 1,
                    spawn: true
                },
                targetId: site.id,
                targetPos: { x: site.pos.x, y: site.pos.y, roomName: site.pos.roomName },
                data: {
                    remoteRoom,
                    targetPos: { x: site.pos.x, y: site.pos.y, roomName: site.pos.roomName },
                    sourceIds,
                    containerIds,
                    requiredWork: 4
                },
                priority: 55
            });
        }
    }
}

module.exports = {
    makeKey(context) {
        const roomName = context.sponsorRoom || context.targetRoom;
        return missionKeys.makeUserMissionKey(
            roomName,
            'remoteBuild',
            context.contract && context.contract.name ? context.contract.name : null,
            context.namespace || 'remoteBuild'
        );
    },

    reconcileRoom({ room, intel, context, missionBoard }) {
        if (!room || !intel || !missionBoard) return;
        if (context && context.opState === 'EMERGENCY') return;
        if (!missionThrottle.shouldRunReconcile('remoteBuild', room.name, Game.time)) return;
        missionGeneratorBridge.runGeneratorAsTyped({
            room,
            intel,
            context,
            missionBoard,
            namespace: 'remoteBuild',
            type: 'remoteBuild',
            generate: (scanRoom, scanIntel, scanContext, contracts) =>
                generateRemoteBuildContracts(scanRoom, scanContext, missionBoard, contracts),
            mapContract: (contract) => ({
                sponsorRoom: room.name,
                targetRoom: (contract && contract.targetPos && contract.targetPos.roomName) || room.name
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
            type: 'remoteBuild',
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
        mission.priority = Number.isFinite(contract.priority) ? contract.priority : (mission.priority || 55);
        mission.targetId = contract.targetId || mission.targetId || null;
        mission.meta = mission.meta || {};
        mission.meta.contractType = contract.type || mission.meta.contractType || null;
        mission.meta.missionName = contract.name || mission.meta.missionName || null;
        mission.progress = mission.progress || {};
        mission.progress.stage = 'remote_build';
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



