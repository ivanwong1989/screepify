const remoteUtils = require('managers_overseer_utils_overseer.remote');
const heap = require('utils_heap');
const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const policyConstants = require('managers_overseer_policy_room.policy.constants');

const REMOTE_RESERVE_CONTEXT_INDEX_STORE = 'remoteReserveContextIndex';
const RESERVE_RENEW_THRESHOLD = 2000;

function cleanupAssigned(mission) {
    if (!mission.assigned) mission.assigned = { primary: [], support: [] };
    if (!Array.isArray(mission.assigned.primary)) mission.assigned.primary = [];
    const missionName = mission && mission.meta ? mission.meta.missionName : null;
    const roomName = mission && mission.sponsorRoom ? mission.sponsorRoom : null;
    if (missionName) {
        const observed = [];
        for (const name in Game.creeps) {
            const creep = Game.creeps[name];
            if (!creep || !creep.my || !creep.memory) continue;
            if (creep.memory.role !== 'reserver') continue;
            if (roomName && creep.memory.room && creep.memory.room !== roomName) continue;
            if (creep.memory.missionName !== missionName) continue;
            observed.push(creep.name);
        }
        mission.assigned.primary = observed;
        return;
    }
    mission.assigned.primary = mission.assigned.primary.filter(name => !!Game.creeps[name]);
}

function getMyUsername() {
    if (global && typeof global.MY_USERNAME === 'string' && global.MY_USERNAME.length > 0) {
        return global.MY_USERNAME;
    }
    for (const name in Game.spawns) {
        const spawn = Game.spawns[name];
        if (!spawn || !spawn.owner || !spawn.owner.username) continue;
        return spawn.owner.username;
    }
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room || !room.controller || !room.controller.my) continue;
        if (room.controller.owner && room.controller.owner.username) {
            return room.controller.owner.username;
        }
    }
    return null;
}

function toPosObject(pos, fallbackRoomName) {
    if (!pos) return null;
    const x = Number(pos.x);
    const y = Number(pos.y);
    const roomName = pos.roomName || fallbackRoomName || null;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !roomName) return null;
    return { x, y, roomName };
}

function getRemoteContextIndex(homeRoom, roomState) {
    if (!homeRoom) return { entries: [], byName: Object.create(null) };
    const store = heap.getStore(REMOTE_RESERVE_CONTEXT_INDEX_STORE, { ttl: 3 });
    const key = `${homeRoom.name}:${roomState || 'none'}:${Game.time}`;
    const cached = store[key];
    if (cached && Array.isArray(cached.entries) && cached.byName) return cached;

    const entries = remoteUtils.getRemoteEconomicContext(homeRoom, {
        roomState: roomState || null,
        maxScoutAge: 4000
    });
    const byName = Object.create(null);
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry && entry.name) byName[entry.name] = entry;
    }
    const next = { tick: Game.time, entries, byName };
    store[key] = next;
    return next;
}

function getRemoteEntry(homeRoom, remoteRoomName, roomState) {
    if (!homeRoom || !remoteRoomName) return null;
    const ctx = getRemoteContextIndex(homeRoom, roomState);
    return ctx.byName[remoteRoomName] || null;
}

function buildGoalContract(mission) {
    return {
        kind: 'service',
        target: {
            kind: 'remote_controller',
            roomName: mission.targetRoom,
            id: mission.targetId || null
        },
        success: {
            kind: 'sustained_remote_reserve',
            minAssignedPrimary: 1
        },
        persistWhile: {
            sponsorOwned: true,
            remoteEnabled: true,
            targetExistsInRemoteContext: true
        },
        completion: 'never'
    };
}

function ensureGoalContract(mission) {
    if (!mission.goal || typeof mission.goal !== 'object') {
        mission.goal = buildGoalContract(mission);
        return;
    }
    mission.goal.kind = mission.goal.kind || 'service';
    mission.goal.target = mission.goal.target || {};
    mission.goal.target.kind = mission.goal.target.kind || 'remote_controller';
    mission.goal.target.roomName = mission.goal.target.roomName || mission.targetRoom;
    mission.goal.target.id = mission.goal.target.id || mission.targetId || null;
    mission.goal.success = mission.goal.success || {};
    mission.goal.success.kind = mission.goal.success.kind || 'sustained_remote_reserve';
    mission.goal.success.minAssignedPrimary = Number.isFinite(mission.goal.success.minAssignedPrimary)
        ? mission.goal.success.minAssignedPrimary
        : 1;
    mission.goal.persistWhile = mission.goal.persistWhile || {};
    if (mission.goal.persistWhile.sponsorOwned !== true) mission.goal.persistWhile.sponsorOwned = true;
    if (mission.goal.persistWhile.remoteEnabled !== true) mission.goal.persistWhile.remoteEnabled = true;
    if (mission.goal.persistWhile.targetExistsInRemoteContext !== true) mission.goal.persistWhile.targetExistsInRemoteContext = true;
    mission.goal.completion = mission.goal.completion || 'never';
}

function updateProgress(mission, reservationNeeded, ticksRemaining) {
    mission.progress = mission.progress || {};
    mission.progress.stage = 'reserve';
    mission.progress.goalState = reservationNeeded
        ? (mission.assigned.primary.length > 0 ? 'sustaining' : 'seeking_assignment')
        : 'satisfied';
    mission.progress.assignedPrimary = mission.assigned.primary.length;
    mission.progress.reservationNeeded = !!reservationNeeded;
    mission.progress.ticksRemaining = Number.isFinite(ticksRemaining) ? ticksRemaining : 0;
}

module.exports = {
    makeKey(context) {
        return missionKeys.makeRemoteReserveKey(
            context.sponsorRoom,
            context.remoteRoom
        );
    },

    discover({ room, context }) {
        if (!room) return [];
        if (Memory.remoteMissionsEnabled === false) return [];
        const policy = context && context.policy ? context.policy : null;
        const phase = policy && policy.phase ? policy.phase : policyConstants.PHASE.BOOTSTRAP;
        const state = policy && policy.state ? policy.state : policyConstants.STATE.RECOVER;
        const phaseRank = policyConstants.PHASE_RANK[phase] || 0;
        if (phaseRank < policyConstants.PHASE_RANK[policyConstants.PHASE.LINKS]) return [];
        if (
            state === policyConstants.STATE.CRITICAL
            || state === policyConstants.STATE.RECOVER
            || state === policyConstants.STATE.DEFENSIVE
            || state === policyConstants.STATE.SIEGE
        ) return [];

        const remoteCtx = getRemoteContextIndex(room, state);
        const entries = remoteCtx.entries;
        const out = [];

        for (let i = 0; i < entries.length; i++) {
            const wrapped = entries[i];
            const remoteRoom = wrapped && wrapped.name ? wrapped.name : null;
            const enabled = !!(wrapped && wrapped.enabled);
            if (!enabled || !remoteRoom) continue;

            const createContext = {
                sponsorRoom: room.name,
                remoteRoom,
                priority: 75
            };
            out.push({
                key: this.makeKey(createContext),
                createContext,
                discoveredMeta: {
                    remoteRoom
                }
            });
        }

        return out;
    },

    create(context) {
        const now = Game.time;
        return {
            id: this.makeKey(context),
            key: this.makeKey(context),
            type: 'remoteReserve',
            class: missionClasses.SERVICE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.remoteRoom,
            priority: Number.isFinite(context.priority) ? context.priority : 75,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: null,
            assigned: { primary: [], support: [] },
            demand: { role: 'reserver', count: 1, bodyProfile: 'reserver' },
            goal: {
                kind: 'service',
                target: {
                    kind: 'remote_controller',
                    roomName: context.remoteRoom,
                    id: null
                },
                success: {
                    kind: 'sustained_remote_reserve',
                    minAssignedPrimary: 1
                },
                persistWhile: {
                    sponsorOwned: true,
                    remoteEnabled: true,
                    targetExistsInRemoteContext: true
                },
                completion: 'never'
            },
            progress: {
                stage: 'reserve',
                goalState: 'seeking_assignment',
                assignedPrimary: 0,
                reservationNeeded: true,
                ticksRemaining: 0
            },
            meta: {
                remoteRoom: context.remoteRoom,
                missionName: `remote:reserve:${context.remoteRoom}`
            },
            statusReason: null
        };
    },

    validate(mission, runtimeCtx) {
        const sponsor = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[mission.sponsorRoom];
        const context = runtimeCtx && runtimeCtx.context ? runtimeCtx.context : null;
        if (!sponsor || !sponsor.controller || !sponsor.controller.my) return false;

        const roomState = context && context.policy && context.policy.state ? context.policy.state : null;
        const entry = getRemoteEntry(
            sponsor,
            (mission.meta && mission.meta.remoteRoom) || mission.targetRoom,
            roomState
        );
        if (!entry || !entry.enabled) return false;
        if (runtimeCtx) runtimeCtx.remoteReserveEntry = entry;
        return true;
    },

    refresh(mission) {
        cleanupAssigned(mission);
        ensureGoalContract(mission);
        mission.meta = mission.meta || {};

        const remoteRoom = mission.meta.remoteRoom || mission.targetRoom;
        mission.meta.remoteRoom = remoteRoom;
        mission.meta.missionName = mission.meta.missionName || `remote:reserve:${remoteRoom}`;

        const remote = remoteRoom ? Game.rooms[remoteRoom] : null;
        const controller = remote && remote.controller ? remote.controller : null;
        const myUser = getMyUsername();
        const reservation = controller && controller.reservation ? controller.reservation : null;
        const reservedByMe = !!(reservation && myUser && reservation.username === myUser);
        const ticksRemaining = reservedByMe && Number.isFinite(reservation.ticksToEnd)
            ? reservation.ticksToEnd
            : 0;

        const controllerId = controller ? controller.id : (mission.meta.controllerId || null);
        const controllerPos = controller
            ? toPosObject(controller.pos, remoteRoom)
            : (mission.meta.controllerPos || null);

        const reservationNeeded = !reservedByMe || ticksRemaining < RESERVE_RENEW_THRESHOLD;
        mission.targetId = controllerId || null;
        mission.meta.controllerId = controllerId || null;
        mission.meta.controllerPos = controllerPos || null;
        mission.meta.reservationTicks = ticksRemaining;
        mission.meta.reservationNeeded = reservationNeeded;

        mission.requirements = {
            archetype: 'reserver',
            requiredClaim: reservationNeeded ? 1 : 0,
            minCount: reservationNeeded ? 1 : 0,
            maxCount: reservationNeeded ? 1 : 0
        };
        mission.demand = {
            role: 'reserver',
            count: reservationNeeded ? Math.max(0, 1 - mission.assigned.primary.length) : 0,
            bodyProfile: 'reserver'
        };
        mission.data = {
            remoteRoom,
            targetRoom: remoteRoom,
            controllerId: mission.meta.controllerId || null,
            controllerPos: mission.meta.controllerPos || null,
            reservationNeeded,
            reservationTicks: ticksRemaining
        };

        if (mission.assigned.primary.length > 0 && reservationNeeded) mission.lastProgressTick = Game.time;
        updateProgress(mission, reservationNeeded, ticksRemaining);
    },

    isComplete() {
        return false;
    },

    toContractMission(mission) {
        return {
            name: mission.meta && mission.meta.missionName
                ? mission.meta.missionName
                : `remote:reserve:${mission.targetRoom}`,
            type: 'remote_reserve',
            archetype: 'reserver',
            requirements: mission.requirements || {
                archetype: 'reserver',
                requiredClaim: 1,
                minCount: 1,
                maxCount: 1
            },
            data: {
                targetRoom: mission.targetRoom,
                remoteRoom: mission.targetRoom,
                controllerId: mission.data && mission.data.controllerId ? mission.data.controllerId : null,
                controllerPos: mission.data && mission.data.controllerPos ? mission.data.controllerPos : null,
                reservationNeeded: mission.data && mission.data.reservationNeeded === false ? false : true,
                reservationTicks: mission.data && Number.isFinite(mission.data.reservationTicks)
                    ? mission.data.reservationTicks
                    : 0
            },
            priority: Number.isFinite(mission.priority) ? mission.priority : 75
        };
    }
};
