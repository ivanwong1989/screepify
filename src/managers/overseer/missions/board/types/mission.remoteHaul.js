'use strict';

const remoteUtils = require('managers_overseer_utils_overseer.remote');
const remoteHaulPathing = require('managers_overseer_utils_overseer.remoteHaulPathing');
const heap = require('utils_heap');
const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const policyConstants = require('managers_overseer_policy_room.policy.constants');

const REMOTE_HAUL_LANE_LAYOUT_VERSION = 4;
const TARGET_WORK = 7;
const ENERGY_PER_TICK = 2 * TARGET_WORK;
const TRANSFER_BUFFER_TICKS = 2;
const LONG_LANE_DAMP_START = 20;
const LONG_LANE_DAMP_FACTOR = 0.65;
const MAX_REMOTE_HAULER_CARRY_PARTS = 16;
const MAX_REMOTE_HAULERS_PER_LANE = 2;
const REMOTE_HAUL_PLAN_CACHE_TTL = 250;
const REMOTE_HAUL_PLAN_STORE = 'remoteHaulPlan';
const REMOTE_HAUL_REPLAN_INTERVAL = 97;
const REMOTE_HAUL_CONTEXT_INDEX_STORE = 'remoteHaulContextIndex';

function cleanupAssigned(mission) {
    if (!mission.assigned) mission.assigned = { primary: [], support: [] };
    if (!Array.isArray(mission.assigned.primary)) mission.assigned.primary = [];
    mission.assigned.primary = mission.assigned.primary.filter(name => !!Game.creeps[name]);
}

function toRoomPosition(pos) {
    if (!pos || !pos.roomName) return null;
    const x = Number(pos.x);
    const y = Number(pos.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return new RoomPosition(x, y, pos.roomName);
}

function buildOtherSourceRings(sources, currentSourceId, roomName) {
    const blockedTiles = [];
    if (!Array.isArray(sources) || !currentSourceId || !roomName) return blockedTiles;

    for (let i = 0; i < sources.length; i++) {
        const src = sources[i];
        if (!src || !src.id || src.id === currentSourceId) continue;
        const sx = Number(src.x);
        const sy = Number(src.y);
        if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const x = sx + dx;
                const y = sy + dy;
                if (x < 0 || x > 49 || y < 0 || y > 49) continue;
                blockedTiles.push({ roomName, x, y });
            }
        }
    }
    return blockedTiles;
}

function getRemoteContextIndex(homeRoom, roomState) {
    if (!homeRoom) return { entries: [], byName: Object.create(null) };
    const store = heap.getStore(REMOTE_HAUL_CONTEXT_INDEX_STORE, { ttl: 3 });
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

function getDropoffTarget(room, intel) {
    if (!room || !intel) return null;
    const miningContainerIds = new Set((intel.sources || []).map(s => s.containerId).filter(id => !!id));
    const allContainers = intel.structures && intel.structures[STRUCTURE_CONTAINER]
        ? intel.structures[STRUCTURE_CONTAINER]
        : [];
    const nonMiningContainers = allContainers.filter(c => !miningContainerIds.has(c.id));
    return room.storage || nonMiningContainers[0] || null;
}

function buildGoalContract(mission) {
    return {
        kind: 'service',
        target: {
            kind: 'remote_energy_lane',
            roomName: mission.targetRoom,
            id: mission.targetId
        },
        success: {
            kind: 'sustained_remote_haul',
            minAssignedPrimary: 1
        },
        persistWhile: {
            sponsorOwned: true,
            remoteEnabled: true,
            dropoffAvailable: true
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
    mission.goal.target.kind = mission.goal.target.kind || 'remote_energy_lane';
    mission.goal.target.roomName = mission.goal.target.roomName || mission.targetRoom;
    mission.goal.target.id = mission.goal.target.id || mission.targetId;
    mission.goal.success = mission.goal.success || {};
    mission.goal.success.kind = mission.goal.success.kind || 'sustained_remote_haul';
    mission.goal.success.minAssignedPrimary = Number.isFinite(mission.goal.success.minAssignedPrimary)
        ? mission.goal.success.minAssignedPrimary
        : 1;
    mission.goal.persistWhile = mission.goal.persistWhile || {};
    if (mission.goal.persistWhile.sponsorOwned !== true) mission.goal.persistWhile.sponsorOwned = true;
    if (mission.goal.persistWhile.remoteEnabled !== true) mission.goal.persistWhile.remoteEnabled = true;
    if (mission.goal.persistWhile.dropoffAvailable !== true) mission.goal.persistWhile.dropoffAvailable = true;
    mission.goal.completion = mission.goal.completion || 'never';
}

function buildPlanSignature(mission, source, dropoffTarget, budget) {
    const pickupMode = (source && source.containerId && source.containerPos) ? 'container' : 'drop';
    const pickupId = pickupMode === 'container' ? source.containerId : source.id;
    const budgetBucket = Math.max(1, Math.floor((budget || 0) / 100));
    return [
        mission.sponsorRoom,
        mission.targetRoom,
        mission.targetId,
        pickupId,
        pickupMode,
        dropoffTarget ? dropoffTarget.id : '-',
        budgetBucket
    ].join(':');
}

function getCachedPlan(signature) {
    const store = heap.getStore(REMOTE_HAUL_PLAN_STORE, { ttl: REMOTE_HAUL_PLAN_CACHE_TTL });
    const cached = store[signature];
    if (!cached || !Number.isFinite(cached.tick)) return null;
    if ((Game.time - cached.tick) > REMOTE_HAUL_REPLAN_INTERVAL) return null;
    return cached;
}

function setCachedPlan(signature, plan) {
    const store = heap.getStore(REMOTE_HAUL_PLAN_STORE, { ttl: REMOTE_HAUL_PLAN_CACHE_TTL });
    store[signature] = Object.assign({ tick: Game.time }, plan);
}

function shouldReplan(mission, signature) {
    const meta = mission.meta || {};
    if (!meta.planSignature) return true;
    if (meta.planSignature !== signature) return true;
    if (!Number.isFinite(meta.planTick)) return true;
    if ((Game.time - meta.planTick) >= REMOTE_HAUL_REPLAN_INTERVAL) return true;
    return !(mission.data && mission.data.laneKeyToPickup && mission.data.pickupId && mission.data.dropoffId);
}

function updateProgress(mission, planState) {
    mission.progress = mission.progress || {};
    mission.progress.stage = 'lane';
    mission.progress.goalState = mission.assigned.primary.length > 0
        ? 'sustaining'
        : 'seeking_assignment';
    mission.progress.planState = planState || 'cached';
    mission.progress.assignedPrimary = mission.assigned.primary.length;
    mission.progress.lastPlanTick = mission.meta && Number.isFinite(mission.meta.planTick)
        ? mission.meta.planTick
        : 0;
}

function buildLanePlan(planCtx) {
    const hasContainer = !!(planCtx.source.containerId && planCtx.source.containerPos);
    const pickupId = hasContainer ? planCtx.source.containerId : planCtx.source.id;
    const standPos = planCtx.source.standPos ? toRoomPosition(planCtx.source.standPos) : null;
    const pickupRange = hasContainer ? 1 : (standPos ? 1 : 2);
    const pickupPos = hasContainer
        ? toRoomPosition(planCtx.source.containerPos)
        : (standPos || new RoomPosition(planCtx.source.x, planCtx.source.y, planCtx.mission.targetRoom));
    if (!pickupPos) return null;

    const targetSignature = `v${REMOTE_HAUL_LANE_LAYOUT_VERSION}:dropoff:${planCtx.dropoffTarget.id}`;
    const laneManager = remoteHaulPathing.createLaneManager(planCtx.room.name, targetSignature);
    const laneKeyBase = `rhaul:${planCtx.room.name}:${pickupId}:${planCtx.dropoffTarget.id}`;
    const laneKeyToPickup = `${laneKeyBase}:F`;
    const laneKeyToDropoff = `${laneKeyBase}:R`;

    let pathLen = laneManager.getKnownPathLen(pickupId) || 1;
    const blockedTiles = buildOtherSourceRings(planCtx.sourcesInfo, planCtx.source.id, planCtx.mission.targetRoom);
    const rebuilt = laneManager.ensureLanes(
        pickupId,
        planCtx.dropoffTarget.pos,
        pickupPos,
        laneKeyToPickup,
        laneKeyToDropoff,
        { blockedTiles }
    );
    pathLen = rebuilt.pathLen || pathLen;

    const effectivePathLen = pathLen > LONG_LANE_DAMP_START
        ? Math.floor(LONG_LANE_DAMP_START + ((pathLen - LONG_LANE_DAMP_START) * LONG_LANE_DAMP_FACTOR))
        : pathLen;
    const roundTrip = (effectivePathLen * 2) + TRANSFER_BUFFER_TICKS;
    const carryParts = Math.min(Math.max(1, Math.floor((planCtx.budget || 0) / 100)), MAX_REMOTE_HAULER_CARRY_PARTS);
    const requiredCarryParts = Math.ceil((ENERGY_PER_TICK * roundTrip) / 50);
    const reqCount = Math.max(
        1,
        Math.min(MAX_REMOTE_HAULERS_PER_LANE, Math.ceil(requiredCarryParts / carryParts))
    );

    return {
        pickupId,
        pickupMode: hasContainer ? 'container' : 'drop',
        pickupRange,
        pickupPos: { x: pickupPos.x, y: pickupPos.y, roomName: pickupPos.roomName },
        dropoffId: planCtx.dropoffTarget.id,
        dropoffPos: {
            x: planCtx.dropoffTarget.pos.x,
            y: planCtx.dropoffTarget.pos.y,
            roomName: planCtx.dropoffTarget.pos.roomName
        },
        laneKeyToPickup,
        laneKeyToDropoff,
        laneKey: laneKeyToPickup,
        laneSig: targetSignature,
        pathLen,
        effectivePathLen,
        requiredCarryParts,
        reqCount,
        carryParts,
        rebuilt: !!(rebuilt && rebuilt.built)
    };
}

module.exports = {
    makeKey(context) {
        return missionKeys.makeRemoteHaulKey(
            context.sponsorRoom,
            context.remoteRoom,
            context.sourceId
        );
    },

    discover({ room, intel, context }) {
        if (!room || !intel) return [];
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
        if (!getDropoffTarget(room, intel)) return [];

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
                    priority: 70
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
        return {
            id: this.makeKey(context),
            key: this.makeKey(context),
            type: 'remoteHaul',
            class: missionClasses.SERVICE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.remoteRoom,
            priority: Number.isFinite(context.priority) ? context.priority : 70,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: context.sourceId,
            assigned: { primary: [], support: [] },
            demand: { role: 'remote_hauler', count: 1, bodyProfile: 'remote_hauler' },
            goal: {
                kind: 'service',
                target: {
                    kind: 'remote_energy_lane',
                    roomName: context.remoteRoom,
                    id: context.sourceId
                },
                success: {
                    kind: 'sustained_remote_haul',
                    minAssignedPrimary: 1
                },
                persistWhile: {
                    sponsorOwned: true,
                    remoteEnabled: true,
                    dropoffAvailable: true
                },
                completion: 'never'
            },
            progress: {
                stage: 'lane',
                pathLen: 1,
                goalState: 'seeking_assignment',
                planState: 'pending',
                assignedPrimary: 0,
                lastPlanTick: 0
            },
            meta: {
                remoteRoom: context.remoteRoom,
                sourceId: context.sourceId,
                missionName: `remote:haul:${context.remoteRoom}:drop:${context.sourceId}`
            },
            statusReason: null
        };
    },

    validate(mission, runtimeCtx) {
        const sponsor = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[mission.sponsorRoom];
        const context = runtimeCtx && runtimeCtx.context ? runtimeCtx.context : null;
        if (!sponsor || !sponsor.controller || !sponsor.controller.my) return false;
        const intel = runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null;
        if (!intel) return false;
        const dropoff = getDropoffTarget(sponsor, intel);
        if (!dropoff) return false;

        const roomState = context && context.policy && context.policy.state ? context.policy.state : null;
        const entry = getRemoteEntry(sponsor, mission.meta && mission.meta.remoteRoom, roomState);
        if (!entry || !entry.enabled) return false;
        const source = getSourceInfo(entry, mission.targetId);
        if (!source) return false;
        if (runtimeCtx) {
            runtimeCtx.remoteHaulDropoff = dropoff;
            runtimeCtx.remoteHaulEntry = entry;
            runtimeCtx.remoteHaulSource = source;
        }
        return true;
    },

    refresh(mission, runtimeCtx) {
        cleanupAssigned(mission);
        ensureGoalContract(mission);
        mission.meta = mission.meta || {};
        mission.progress = mission.progress || {};

        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[mission.sponsorRoom];
        const intel = runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null;
        const context = runtimeCtx && runtimeCtx.context ? runtimeCtx.context : null;
        const roomState = context && context.policy && context.policy.state ? context.policy.state : null;
        if (!room || !intel) {
            updateProgress(mission, 'cached');
            return;
        }

        const dropoffTarget = runtimeCtx && runtimeCtx.remoteHaulDropoff
            ? runtimeCtx.remoteHaulDropoff
            : getDropoffTarget(room, intel);
        if (!dropoffTarget) {
            updateProgress(mission, 'cached');
            return;
        }

        const entryWrap = runtimeCtx && runtimeCtx.remoteHaulEntry
            ? runtimeCtx.remoteHaulEntry
            : getRemoteEntry(room, mission.meta.remoteRoom || mission.targetRoom, roomState);
        const entry = entryWrap && entryWrap.entry ? entryWrap.entry : null;
        const source = runtimeCtx && runtimeCtx.remoteHaulSource
            ? runtimeCtx.remoteHaulSource
            : getSourceInfo(entryWrap, mission.targetId);
        if (!source) {
            updateProgress(mission, 'cached');
            return;
        }

        const budget = Number.isFinite(context && context.budget) ? context.budget : room.energyCapacityAvailable;
        const planSignature = buildPlanSignature(mission, source, dropoffTarget, budget);
        let planState = 'cached';
        let plan = null;
        if (shouldReplan(mission, planSignature)) {
            const cachedPlan = getCachedPlan(planSignature);
            if (cachedPlan) {
                plan = cachedPlan;
                planState = 'cache_hit';
            } else {
                plan = buildLanePlan({
                    mission,
                    room,
                    source,
                    dropoffTarget,
                    budget,
                    sourcesInfo: entry && entry.sourcesInfo ? entry.sourcesInfo : []
                });
                if (!plan) {
                    updateProgress(mission, 'cached');
                    return;
                }
                setCachedPlan(planSignature, plan);
                planState = 'replanned';
            }
        } else {
            plan = {
                pickupId: mission.meta.pickupId,
                pickupMode: mission.meta.pickupMode || (mission.data && mission.data.pickupMode) || 'drop',
                pickupRange: mission.data && Number.isFinite(mission.data.pickupRange)
                    ? mission.data.pickupRange
                    : ((mission.meta.pickupMode || (mission.data && mission.data.pickupMode)) === 'container' ? 1 : 2),
                pickupPos: mission.data && mission.data.pickupPos ? mission.data.pickupPos : null,
                dropoffId: mission.data && mission.data.dropoffId ? mission.data.dropoffId : (dropoffTarget && dropoffTarget.id),
                dropoffPos: mission.data && mission.data.dropoffPos
                    ? mission.data.dropoffPos
                    : (dropoffTarget ? {
                        x: dropoffTarget.pos.x,
                        y: dropoffTarget.pos.y,
                        roomName: dropoffTarget.pos.roomName
                    } : null),
                laneKeyToPickup: mission.data && mission.data.laneKeyToPickup ? mission.data.laneKeyToPickup : null,
                laneKeyToDropoff: mission.data && mission.data.laneKeyToDropoff ? mission.data.laneKeyToDropoff : null,
                laneKey: mission.data && mission.data.laneKey ? mission.data.laneKey : null,
                laneSig: mission.data && mission.data.laneSig ? mission.data.laneSig : null,
                pathLen: Number.isFinite(mission.progress.pathLen) ? mission.progress.pathLen : 1,
                effectivePathLen: Number.isFinite(mission.progress.effectivePathLen) ? mission.progress.effectivePathLen : 1,
                requiredCarryParts: mission.requirements && Number.isFinite(mission.requirements.requiredCarry)
                    ? mission.requirements.requiredCarry
                    : 1,
                reqCount: mission.requirements && Number.isFinite(mission.requirements.maxCount)
                    ? mission.requirements.maxCount
                    : 1,
                carryParts: Math.min(Math.max(1, Math.floor((budget || 0) / 100)), MAX_REMOTE_HAULER_CARRY_PARTS),
                rebuilt: false
            };
        }

        mission.meta.pickupId = plan.pickupId;
        mission.meta.pickupMode = plan.pickupMode;
        mission.meta.planSignature = planSignature;
        if (planState !== 'cached') mission.meta.planTick = Game.time;
        mission.meta.missionName = plan.pickupMode === 'container'
            ? `remote:haul:${mission.targetRoom}:${source.containerId}`
            : `remote:haul:${mission.targetRoom}:drop:${source.id}`;

        mission.progress.pathLen = plan.pathLen;
        mission.progress.effectivePathLen = plan.effectivePathLen;
        mission.requirements = {
            archetype: 'remote_hauler',
            requiredCarry: plan.requiredCarryParts,
            minCount: 1,
            maxCount: plan.reqCount,
            maxCarryParts: MAX_REMOTE_HAULER_CARRY_PARTS,
            spawnFromFleet: false
        };
        mission.demand = {
            role: 'remote_hauler',
            count: Math.max(0, plan.reqCount - mission.assigned.primary.length),
            bodyProfile: 'remote_hauler'
        };
        mission.data = {
            homeRoom: room.name,
            remoteRoom: mission.targetRoom,
            pickupId: plan.pickupId,
            pickupPos: plan.pickupPos,
            dropoffId: plan.dropoffId,
            dropoffPos: plan.dropoffPos,
            resourceType: RESOURCE_ENERGY,
            pickupMode: plan.pickupMode,
            pickupRange: Number.isFinite(plan.pickupRange)
                ? plan.pickupRange
                : (plan.pickupMode === 'container' ? 1 : 2),
            laneKeyToPickup: plan.laneKeyToPickup,
            laneKeyToDropoff: plan.laneKeyToDropoff,
            laneKey: plan.laneKey,
            laneSig: plan.laneSig
        };
        if (mission.assigned.primary.length > 0) mission.lastProgressTick = Game.time;
        updateProgress(mission, planState);

        if (typeof debug === 'function') {
            debug('mission.remote.haul',
                `[RemoteHaul] ${room.name} -> ${mission.targetRoom} mode=${plan.pickupMode} ` +
                `pickup=${plan.pickupId} path=${plan.pathLen} effPath=${plan.effectivePathLen} ` +
                `carryParts=${plan.carryParts} req=${plan.reqCount} ` +
                `lane=${plan.laneKeyToPickup || '-'}${plan.rebuilt ? ' (rebuilt)' : ''}`);
        }
    },

    isComplete() {
        return false;
    },

    toContractMission(mission) {
        return {
            name: mission.meta && mission.meta.missionName
                ? mission.meta.missionName
                : `remote:haul:${mission.targetRoom}:drop:${mission.targetId}`,
            type: 'remote_haul',
            archetype: 'remote_hauler',
            requirements: mission.requirements || {
                archetype: 'remote_hauler',
                requiredCarry: 1,
                minCount: 1,
                maxCount: MAX_REMOTE_HAULERS_PER_LANE,
                maxCarryParts: MAX_REMOTE_HAULER_CARRY_PARTS,
                spawnFromFleet: false
            },
            data: mission.data || {},
            priority: Number.isFinite(mission.priority) ? mission.priority : 70
        };
    }
};


