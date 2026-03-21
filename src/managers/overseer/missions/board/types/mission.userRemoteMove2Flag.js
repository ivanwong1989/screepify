const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
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

const MOVE2FLAG_COST = 50;

function missionName(mission) {
    const suffix = mission.label ? `${mission.id}:${mission.label}` : mission.id;
    return `move2flag:${suffix}`;
}

function escapeRegExp(value) {
    return ('' + value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectWaypoints(flagName) {
    const root = flagName || 'M';
    const rx = new RegExp(`^${escapeRegExp(root)}(\\d+)$`);
    const items = [];
    for (const key in Game.flags) {
        const flag = Game.flags[key];
        if (!flag || !flag.pos || !flag.name) continue;
        const match = rx.exec(flag.name);
        if (!match) continue;
        const order = Number(match[1]);
        if (!Number.isFinite(order)) continue;
        items.push({
            order,
            name: flag.name,
            pos: { x: flag.pos.x, y: flag.pos.y, roomName: flag.pos.roomName }
        });
    }
    items.sort((a, b) => a.order - b.order);
    return {
        waypointNames: items.map(i => i.name),
        waypoints: items.map(i => i.pos)
    };
}

function generateMove2FlagContracts(room, missions) {
    if (!room || !Array.isArray(missions)) return;
    const canSpawn = room.energyCapacityAvailable >= MOVE2FLAG_COST;
    const userRouteMissions = userMissions.getByType('move2flag');
    if (!Array.isArray(userRouteMissions) || userRouteMissions.length <= 0) return;

    for (let i = 0; i < userRouteMissions.length; i++) {
        const mission = userRouteMissions[i];
        if (!mission || mission.enabled === false) continue;
        if (mission.sponsorRoom !== room.name) continue;

        const flagName = (mission.flagName || 'M').trim();
        if (!flagName) continue;
        const flag = Game.flags[flagName];
        if (!flag || !flag.pos) {
            if (mission.persist !== true) userMissions.removeMission(mission.id);
            continue;
        }

        const wp = collectWaypoints(flagName);
        const targetPos = { x: flag.pos.x, y: flag.pos.y, roomName: flag.pos.roomName };
        missions.push({
            name: missionName(mission),
            type: 'move2flag',
            archetype: 'move2flag',
            requirements: {
                archetype: 'move2flag',
                minCount: 1,
                maxCount: 1,
                spawn: canSpawn
            },
            data: {
                userMissionId: mission.id,
                sponsorRoom: room.name,
                flagName,
                targetPos,
                waypointNames: wp.waypointNames,
                waypoints: wp.waypoints
            },
            priority: Number.isFinite(mission.priority) ? mission.priority : 50
        });
    }
}

module.exports = {
    makeKey(context) {
        const roomName = context.targetRoom || context.sponsorRoom;
        const contract = context.contract || null;
        const userMissionId = context.userMissionId || (contract && contract.data && contract.data.userMissionId) || null;
        const fallback = contract && contract.name ? contract.name : 'move2flag';
        return missionKeys.makeUserMissionKey(roomName, 'userRemoteMove2Flag', userMissionId, fallback);
    },

    discover({ room, intel, context }) {
        if (!room) return [];
        const contracts = [];
        generateMove2FlagContracts(room, contracts);

        const out = [];
        for (let i = 0; i < contracts.length; i++) {
            const contract = contracts[i];
            if (!contract) continue;
            const createContext = {
                sponsorRoom: room.name,
                targetRoom: (contract.data && contract.data.targetPos && contract.data.targetPos.roomName) || room.name,
                userMissionId: contract.data ? contract.data.userMissionId : null,
                contract,
                namespace: 'userRemoteMove2Flag'
            };
            out.push({
                key: this.makeKey(createContext),
                createContext,
                discoveredMeta: {
                    contractName: contract.name || null
                }
            });
        }
        return out;
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
                missionName: contract.name || null
            },
            data: { contract },
            statusReason: null
        };
    },

    validate(mission) {
        return !!getContract(mission);
    },

    refresh(mission, runtimeCtx, discovered) {
        cleanupAssigned(mission);
        const discoveredContract = discovered && discovered.createContext
            ? discovered.createContext.contract
            : null;
        if (discoveredContract) {
            mission.data = mission.data || {};
            mission.data.contract = cloneContract(discoveredContract);
        }

        const contract = getContract(mission);
        if (!contract) return;
        mission.priority = Number.isFinite(contract.priority) ? contract.priority : (mission.priority || 50);
        mission.meta = mission.meta || {};
        mission.meta.missionName = contract.name || mission.meta.missionName || null;
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

    toContractMission(mission) {
        const contract = getContract(mission);
        if (!contract) return null;
        return cloneContract(contract);
    }
};



