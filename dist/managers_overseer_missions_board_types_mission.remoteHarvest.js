const remoteUtils = require('managers_overseer_utils_overseer.remote');
const heap = require('utils_heap');
const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const policyConstants = require('managers_overseer_policy_room.policy.constants');

const REMOTE_HARVEST_PLAN_CACHE_TTL = 300;
const REMOTE_HARVEST_PLAN_STORE = 'remoteHarvestPlan';
const REMOTE_HARVEST_REPLAN_INTERVAL = 151;
const REMOTE_HARVEST_CONTEXT_INDEX_STORE = 'remoteHarvestContextIndex';

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
            if (creep.memory.role !== 'remote_miner') continue;
            if (roomName && creep.memory.room && creep.memory.room !== roomName) continue;
            if (creep.memory.missionName !== missionName) continue;
            observed.push(creep.name);
        }
        mission.assigned.primary = observed;
        return;
    }
    mission.assigned.primary = mission.assigned.primary.filter(name => !!Game.creeps[name]);
}

function getRemoteContextIndex(homeRoom, roomState) {
    if (!homeRoom) return { entries: [], byName: Object.create(null) };
    const store = heap.getStore(REMOTE_HARVEST_CONTEXT_INDEX_STORE, { ttl: 3 });
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

function getSourceInfo(entry, sourceId) {
    if (!entry || !entry.entry || !Array.isArray(entry.entry.sourcesInfo) || !sourceId) return null;
    for (let i = 0; i < entry.entry.sourcesInfo.length; i++) {
        const src = entry.entry.sourcesInfo[i];
        if (src && src.id === sourceId) return src;
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

function buildGoalContract(mission) {
    return {
        kind: 'service',
        target: {
            kind: 'remote_source',
            roomName: mission.targetRoom,
            id: mission.targetId
        },
        success: {
            kind: 'sustained_remote_harvest',
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
    mission.goal.target.kind = mission.goal.target.kind || 'remote_source';
    mission.goal.target.roomName = mission.goal.target.roomName || mission.targetRoom;
    mission.goal.target.id = mission.goal.target.id || mission.targetId;
    mission.goal.success = mission.goal.success || {};
    mission.goal.success.kind = mission.goal.success.kind || 'sustained_remote_harvest';
    mission.goal.success.minAssignedPrimary = Number.isFinite(mission.goal.success.minAssignedPrimary)
        ? mission.goal.success.minAssignedPrimary
        : 1;
    mission.goal.persistWhile = mission.goal.persistWhile || {};
    if (mission.goal.persistWhile.sponsorOwned !== true) mission.goal.persistWhile.sponsorOwned = true;
    if (mission.goal.persistWhile.remoteEnabled !== true) mission.goal.persistWhile.remoteEnabled = true;
    if (mission.goal.persistWhile.targetExistsInRemoteContext !== true) mission.goal.persistWhile.targetExistsInRemoteContext = true;
    mission.goal.completion = mission.goal.completion || 'never';
}

function buildPlanSignature(mission, source, availableSpaces) {
    const sourceX = Number.isFinite(source && source.x) ? source.x : -1;
    const sourceY = Number.isFinite(source && source.y) ? source.y : -1;
    const stand = source && source.standPos ? `${source.standPos.x},${source.standPos.y}` : '-';
    const container = source && source.containerId ? source.containerId : '-';
    return [
        mission.sponsorRoom,
        mission.targetRoom,
        mission.targetId,
        container,
        sourceX,
        sourceY,
        stand,
        availableSpaces
    ].join(':');
}

function getCachedPlan(signature) {
    const store = heap.getStore(REMOTE_HARVEST_PLAN_STORE, { ttl: REMOTE_HARVEST_PLAN_CACHE_TTL });
    const cached = store[signature];
    if (!cached || !Number.isFinite(cached.tick)) return null;
    if ((Game.time - cached.tick) > REMOTE_HARVEST_REPLAN_INTERVAL) return null;
    return cached;
}

function setCachedPlan(signature, plan) {
    const store = heap.getStore(REMOTE_HARVEST_PLAN_STORE, { ttl: REMOTE_HARVEST_PLAN_CACHE_TTL });
    store[signature] = Object.assign({ tick: Game.time }, plan);
}

function shouldReplan(mission, signature) {
    const meta = mission.meta || {};
    if (!meta.planSignature) return true;
    if (meta.planSignature !== signature) return true;
    if (!Number.isFinite(meta.planTick)) return true;
    if ((Game.time - meta.planTick) >= REMOTE_HARVEST_REPLAN_INTERVAL) return true;
    return !(mission.data && mission.data.sourcePos);
}

function updateProgress(mission, planState) {
    mission.progress = mission.progress || {};
    mission.progress.stage = 'running';
    mission.progress.goalState = mission.assigned.primary.length > 0
        ? 'sustaining'
        : 'seeking_assignment';
    mission.progress.planState = planState || 'cached';
    mission.progress.assignedPrimary = mission.assigned.primary.length;
    mission.progress.lastPlanTick = mission.meta && Number.isFinite(mission.meta.planTick)
        ? mission.meta.planTick
        : 0;
}

module.exports = {
    makeKey(context) {
        return missionKeys.makeRemoteHarvestKey(
            context.sponsorRoom,
            context.remoteRoom,
            context.sourceId
        );
    },

    discover({ room, intel, context }) {
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
            const entry = wrapped && wrapped.entry ? wrapped.entry : null;
            const enabled = !!(wrapped && wrapped.enabled);
            if (!enabled || !remoteRoom || !entry || !Array.isArray(entry.sourcesInfo)) continue;

            for (let j = 0; j < entry.sourcesInfo.length; j++) {
                const source = entry.sourcesInfo[j];
                if (!source || !source.id) continue;
                const createContext = {
                    sponsorRoom: room.name,
                    remoteRoom,
                    sourceId: source.id,
                    sourcePos: { x: source.x, y: source.y, roomName: remoteRoom },
                    containerId: source.containerId || null,
                    containerPos: source.containerPos || null,
                    standPos: source.standPos || null,
                    availableSpaces: source.availableSpaces || 1,
                    hasContainer: !!(source.hasContainer || source.containerId),
                    priority: 80
                };
                out.push({
                    key: this.makeKey(createContext),
                    createContext,
                    discoveredMeta: {
                        remoteRoom,
                        sourceId: source.id
                    }
                });
            }
        }

        return out;
    },

    create(context) {
        const now = Game.time;
        const availableSpaces = Math.max(1, Number(context.availableSpaces) || 1);
        const hasContainer = !!(context.containerId || context.hasContainer);
        const sourcePos = toPosObject(context.sourcePos, context.remoteRoom);
        const containerPos = toPosObject(context.containerPos, context.remoteRoom);
        const standPos = toPosObject(context.standPos, context.remoteRoom);
        const targetWork = Math.max(1, Number(context.targetWork) || 7);

        return {
            id: this.makeKey(context),
            key: this.makeKey(context),
            type: 'remoteHarvest',
            class: missionClasses.SERVICE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.remoteRoom,
            priority: Number.isFinite(context.priority) ? context.priority : 80,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: context.sourceId,
            assigned: { primary: [], support: [] },
            demand: { role: 'remote_miner', count: 1, bodyProfile: 'remote_miner' },
            goal: {
                kind: 'service',
                target: {
                    kind: 'remote_source',
                    roomName: context.remoteRoom,
                    id: context.sourceId
                },
                success: {
                    kind: 'sustained_remote_harvest',
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
                stage: 'running',
                goalState: 'seeking_assignment',
                planState: 'pending',
                assignedPrimary: 0,
                lastPlanTick: 0
            },
            meta: {
                remoteRoom: context.remoteRoom,
                sourceId: context.sourceId,
                sourcePos,
                containerId: context.containerId || null,
                containerPos,
                standPos,
                availableSpaces,
                targetWork,
                missionName: `remote:harvest:${context.remoteRoom}:${context.sourceId}`
            },
            statusReason: null
        };
    },

    validate(mission, runtimeCtx) {
        const sponsor = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[mission.sponsorRoom];
        const context = runtimeCtx && runtimeCtx.context ? runtimeCtx.context : null;
        if (!sponsor || !sponsor.controller || !sponsor.controller.my) return false;

        const roomState = context && context.policy && context.policy.state ? context.policy.state : null;
        const entry = getRemoteEntry(sponsor, mission.meta && mission.meta.remoteRoom, roomState);
        if (!entry || !entry.enabled) return false;
        const source = getSourceInfo(entry, mission.targetId);
        if (!source) return false;
        if (runtimeCtx) {
            runtimeCtx.remoteHarvestEntry = entry;
            runtimeCtx.remoteHarvestSource = source;
        }
        return true;
    },

    refresh(mission, runtimeCtx) {
        cleanupAssigned(mission);
        ensureGoalContract(mission);
        mission.meta = mission.meta || {};

        const sponsor = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[mission.sponsorRoom];
        const context = runtimeCtx && runtimeCtx.context ? runtimeCtx.context : null;
        const roomState = context && context.policy && context.policy.state ? context.policy.state : null;
        const entry = runtimeCtx && runtimeCtx.remoteHarvestEntry
            ? runtimeCtx.remoteHarvestEntry
            : (sponsor
                ? getRemoteEntry(sponsor, mission.meta.remoteRoom || mission.targetRoom, roomState)
                : null);
        const source = runtimeCtx && runtimeCtx.remoteHarvestSource
            ? runtimeCtx.remoteHarvestSource
            : getSourceInfo(entry, mission.targetId);
        if (!source) {
            updateProgress(mission, 'cached');
            return;
        }

        const hasContainer = !!(source && (source.hasContainer || source.containerId));
        const availableSpaces = Math.max(1, Number(source && source.availableSpaces) || mission.meta.availableSpaces || 1);
        const planSignature = buildPlanSignature(mission, source, availableSpaces);
        let planState = 'cached';
        let plan = null;
        if (shouldReplan(mission, planSignature)) {
            const cachedPlan = getCachedPlan(planSignature);
            if (cachedPlan) {
                plan = cachedPlan;
                planState = 'cache_hit';
            } else {
                plan = {
                    hasContainer,
                    sourcePos: toPosObject(
                        { x: source.x, y: source.y, roomName: mission.meta.remoteRoom || mission.targetRoom },
                        mission.meta.remoteRoom || mission.targetRoom
                    ),
                    containerPos: toPosObject(source.containerPos, mission.meta.remoteRoom || mission.targetRoom),
                    standPos: toPosObject(source.standPos, mission.meta.remoteRoom || mission.targetRoom),
                    containerId: hasContainer ? (source.containerId || null) : null,
                    availableSpaces,
                    mode: hasContainer ? 'static' : 'drop'
                };
                setCachedPlan(planSignature, plan);
                planState = 'replanned';
            }
        } else {
            plan = {
                hasContainer: !!mission.meta.containerId,
                sourcePos: mission.meta.sourcePos || null,
                containerPos: mission.meta.containerPos || null,
                standPos: mission.meta.standPos || null,
                containerId: mission.meta.containerId || null,
                availableSpaces,
                mode: mission.data && mission.data.mode ? mission.data.mode : (mission.meta.containerId ? 'static' : 'drop')
            };
        }

        mission.meta.availableSpaces = availableSpaces;
        mission.meta.containerId = plan.hasContainer ? (plan.containerId || mission.meta.containerId || null) : null;
        mission.meta.containerPos = plan.hasContainer ? (plan.containerPos || null) : null;
        mission.meta.standPos = plan.standPos || null;
        mission.meta.sourcePos = plan.sourcePos || mission.meta.sourcePos || null;
        mission.meta.targetWork = Math.max(1, Number(mission.meta.targetWork) || 7);
        mission.meta.missionName = mission.meta.missionName || `remote:harvest:${mission.meta.remoteRoom}:${mission.targetId}`;
        mission.meta.planSignature = planSignature;
        if (planState !== 'cached') mission.meta.planTick = Game.time;

        // One source must have exactly one assigned remote miner.
        // requiredWork remains as the future body-shape intent signal.
        mission.requirements = {
            archetype: 'remote_miner',
            requiredWork: mission.meta.targetWork,
            minCount: 1,
            maxCount: 1
        };
        mission.demand = {
            role: 'remote_miner',
            count: Math.max(0, 1 - mission.assigned.primary.length),
            bodyProfile: 'remote_miner'
        };
        mission.data = {
            remoteRoom: mission.meta.remoteRoom || mission.targetRoom,
            sourcePos: mission.meta.sourcePos || null,
            containerId: mission.meta.containerId || null,
            containerPos: mission.meta.containerPos || null,
            standPos: mission.meta.standPos || null,
            mode: plan.mode
        };
        if (mission.assigned.primary.length > 0) mission.lastProgressTick = Game.time;
        updateProgress(mission, planState);
    },

    isComplete() {
        return false;
    },

    toContractMission(mission) {
        const sourcePos = mission.meta && mission.meta.sourcePos
            ? new RoomPosition(mission.meta.sourcePos.x, mission.meta.sourcePos.y, mission.meta.sourcePos.roomName)
            : null;
        return {
            name: mission.meta && mission.meta.missionName
                ? mission.meta.missionName
                : `remote:harvest:${mission.targetRoom}:${mission.targetId}`,
            type: 'remote_harvest',
            archetype: 'remote_miner',
            sourceId: mission.targetId,
            pos: sourcePos,
            requirements: mission.requirements || {
                archetype: 'remote_miner',
                requiredWork: mission.meta && Number.isFinite(mission.meta.targetWork) ? mission.meta.targetWork : 7,
                minCount: 1,
                maxCount: 1
            },
            data: {
                remoteRoom: mission.targetRoom,
                sourcePos: mission.data && mission.data.sourcePos ? mission.data.sourcePos : null,
                containerId: mission.data && mission.data.containerId ? mission.data.containerId : null,
                containerPos: mission.data && mission.data.containerPos ? mission.data.containerPos : null,
                standPos: mission.data && mission.data.standPos ? mission.data.standPos : null,
                mode: mission.data && mission.data.mode ? mission.data.mode : 'drop'
            },
            priority: Number.isFinite(mission.priority) ? mission.priority : 80
        };
    }
};


