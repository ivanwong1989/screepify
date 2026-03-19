const heap = require('utils_heap');
const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');

const HARVEST_TRAVEL_CACHE_TTL = 200;
const HARVEST_TRAVEL_STORE = 'harvestTravel';
const HARVEST_PLAN_CACHE_TTL = 250;
const HARVEST_PLAN_STORE = 'harvestPlan';
const HARVEST_PLAN_REPLAN_INTERVAL = 101;

function getSourceAnchorPos(room, source) {
    if (!room || !source || !source.pos) return null;

    const containerId = (source && source.containerId) || null;
    if (containerId) {
        const container = Game.getObjectById(containerId);
        if (container && container.pos) return container.pos;
    }

    const terrain = room.getTerrain();
    let best = null;

    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const x = source.pos.x + dx;
            const y = source.pos.y + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

            const structures = room.lookForAt(LOOK_STRUCTURES, x, y) || [];
            let blocked = false;
            for (let i = 0; i < structures.length; i++) {
                const s = structures[i];
                if (
                    s.structureType !== STRUCTURE_ROAD &&
                    s.structureType !== STRUCTURE_CONTAINER &&
                    !(s.structureType === STRUCTURE_RAMPART && s.my)
                ) {
                    blocked = true;
                    break;
                }
            }
            if (blocked) continue;

            const pos = new RoomPosition(x, y, room.name);
            if (!best) best = pos;
            if (terrain.get(x, y) !== TERRAIN_MASK_SWAMP) return pos;
        }
    }

    return best;
}

function estimateTravelTicks(pathLen, bodyLen, moveParts) {
    if (!pathLen || pathLen <= 0) return 0;
    if (!bodyLen || bodyLen <= 0) return pathLen;
    if (!moveParts || moveParts <= 0) return pathLen * bodyLen;
    const ticksPerStep = Math.max(1, Math.ceil(bodyLen / (2 * moveParts)));
    return pathLen * ticksPerStep;
}

function estimateMinerStatsForPlanning(budget, mode) {
    if (mode === 'mobile') {
        const segments = Math.max(1, Math.floor((budget || 0) / 250));
        const work = Math.min(5, segments);
        const move = Math.max(2, segments * 2);
        const carry = Math.max(1, segments);
        return { work, move, carry, bodyLen: work + move + carry };
    }

    const safeBudget = Math.max(200, budget || 0);
    const work = Math.max(1, Math.min(7, 1 + Math.floor((safeBudget - 200) / 100)));
    const carry = 1;
    const move = 1;
    return { work, move, carry, bodyLen: work + carry + move };
}

function getHarvestTravelEstimate(room, spawns, source, archStats) {
    if (!room || !source || !source.id || !spawns || spawns.length === 0) {
        return {
            sourceDistance: 0,
            travelTicks: 0,
            preSpawnLeadTicks: 0,
            travelFromSpawnId: null
        };
    }

    const store = heap.getStore(HARVEST_TRAVEL_STORE, { ttl: HARVEST_TRAVEL_CACHE_TTL });
    const cacheKey = `${room.name}:${source.id}`;
    let cached = store[cacheKey];

    if (!cached) {
        const anchorPos = getSourceAnchorPos(room, source);
        if (!anchorPos) {
            cached = { sourceDistance: 0, travelFromSpawnId: null };
        } else {
            let bestPathLen = Infinity;
            let bestSpawnId = null;

            for (let i = 0; i < spawns.length; i++) {
                const spawn = spawns[i];
                if (!spawn || !spawn.pos) continue;

                const path = spawn.pos.findPathTo(anchorPos, {
                    range: 0,
                    ignoreCreeps: true,
                    maxOps: 2000
                });
                const pathLen = path ? path.length : 0;
                if (pathLen < bestPathLen) {
                    bestPathLen = pathLen;
                    bestSpawnId = spawn.id;
                }
            }

            cached = {
                sourceDistance: Number.isFinite(bestPathLen) && bestPathLen !== Infinity ? bestPathLen : 0,
                travelFromSpawnId: bestSpawnId
            };
        }
        store[cacheKey] = cached;
    }

    const bodyLen = archStats && Number.isFinite(archStats.bodyLen)
        ? archStats.bodyLen
        : (archStats && archStats.body ? archStats.body.length : 0);
    const moveParts = archStats && archStats.move ? archStats.move : 0;
    const travelTicks = estimateTravelTicks(cached.sourceDistance, bodyLen, moveParts);

    return {
        sourceDistance: cached.sourceDistance || 0,
        travelTicks,
        preSpawnLeadTicks: travelTicks,
        travelFromSpawnId: cached.travelFromSpawnId || null
    };
}

function getSourceInfo(intel, sourceId) {
    const sources = intel && intel.sources ? intel.sources : null;
    if (!sources || !Array.isArray(sources)) return null;
    for (let i = 0; i < sources.length; i++) {
        if (sources[i] && sources[i].id === sourceId) return sources[i];
    }
    return null;
}

function getMiningContainerIdSet(intel) {
    const ids = new Set();
    const sources = intel && Array.isArray(intel.sources) ? intel.sources : [];
    for (let i = 0; i < sources.length; i++) {
        const id = sources[i] && sources[i].containerId ? sources[i].containerId : null;
        if (id) ids.add(id);
    }
    return ids;
}

function hasNonMiningContainers(room, intel) {
    if (!room) return false;
    const miningContainerIds = getMiningContainerIdSet(intel);
    const containers = (intel && intel.structures && intel.structures[STRUCTURE_CONTAINER])
        ? intel.structures[STRUCTURE_CONTAINER]
        : room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER });

    for (let i = 0; i < containers.length; i++) {
        const c = containers[i];
        if (!c || !c.id) continue;
        if (!miningContainerIds.has(c.id)) return true;
    }
    return false;
}

function shouldActivateHarvest(room, intel) {
    if (!room || !room.controller || !room.controller.my) return false;
    if (room.storage) return true;
    if (hasNonMiningContainers(room, intel)) return true;

    const sources = intel && Array.isArray(intel.sources) ? intel.sources : room.find(FIND_SOURCES);
    return (sources && sources.length > 1) || false;
}

function shouldUseHybridEarlyHarvest(room, intel) {
    if (!room || !room.controller || !room.controller.my) return false;
    if (room.storage) return false;
    if (hasNonMiningContainers(room, intel)) return false;
    const sources = intel && Array.isArray(intel.sources) ? intel.sources : room.find(FIND_SOURCES);
    return !!(sources && sources.length > 1);
}

function pickSimpleHarvestAnchorSourceId(room, intel) {
    const sources = intel && Array.isArray(intel.sources)
        ? intel.sources
        : room.find(FIND_SOURCES).map(s => ({ id: s.id, pos: s.pos }));
    if (!sources || sources.length <= 0) return null;

    const spawns = (intel && intel.structures && intel.structures[STRUCTURE_SPAWN]) || room.find(FIND_MY_SPAWNS);
    const anchorSpawn = spawns && spawns.length > 0 ? spawns[0] : null;

    let best = null;
    let bestRange = Infinity;
    for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        if (!source || !source.id || !source.pos) continue;

        const pos = source.pos instanceof RoomPosition
            ? source.pos
            : (source.pos.roomName ? new RoomPosition(source.pos.x, source.pos.y, source.pos.roomName) : null);
        const range = (anchorSpawn && anchorSpawn.pos && pos && pos.roomName === room.name)
            ? anchorSpawn.pos.getRangeTo(pos)
            : Infinity;

        if (!best || range < bestRange || (range === bestRange && String(source.id) < String(best.id))) {
            best = source;
            bestRange = range;
        }
    }

    return best && best.id ? best.id : null;
}

function computeHarvestMode(sourceInfo) {
    return (sourceInfo && sourceInfo.containerId) ? 'static' : 'static_drop';
}

function computeDropoffIds(mode, sourceInfo) {
    if (mode === 'static') {
        const ids = [];
        if (sourceInfo && sourceInfo.linkId) ids.push(sourceInfo.linkId);
        if (sourceInfo && sourceInfo.containerId) ids.push(sourceInfo.containerId);
        return ids;
    }
    return [];
}

function updateAssignmentState(mission) {
    if (!mission.assigned) mission.assigned = { primary: [], support: [] };
    if (!Array.isArray(mission.assigned.primary)) mission.assigned.primary = [];
    if (!Array.isArray(mission.assigned.support)) mission.assigned.support = [];

    const alive = mission.assigned.primary.filter(name => !!Game.creeps[name]);
    mission.assigned.primary = alive;
    if (alive.length > 0) mission.lastProgressTick = Game.time;
}

function buildSpawnSlots(roomName, sourceId, maxCount) {
    const slots = [];
    for (let i = 0; i < Math.max(1, maxCount || 1); i++) {
        slots.push(`harvest:${roomName}:${sourceId}:${i}`);
    }
    return slots;
}

function buildStaticRolesBySlot(mode, maxCount) {
    if (mode !== 'static' || maxCount <= 1) return {};
    const roles = { '0': 'container' };
    for (let i = 1; i < maxCount; i++) roles[String(i)] = 'overflow';
    return roles;
}

function buildHarvestGoalContract(mission) {
    const targetRoom = mission.targetRoom || mission.sponsorRoom;
    return {
        kind: 'service',
        target: {
            kind: 'source',
            roomName: targetRoom,
            id: mission.targetId
        },
        success: {
            kind: 'sustained_harvest',
            minAssignedPrimary: 1
        },
        persistWhile: {
            sponsorOwned: true,
            targetExistsWhenVisible: true
        },
        completion: 'never'
    };
}

function ensureGoalContract(mission) {
    if (!mission.goal || typeof mission.goal !== 'object') {
        mission.goal = buildHarvestGoalContract(mission);
        return;
    }
    mission.goal.kind = mission.goal.kind || 'service';
    mission.goal.target = mission.goal.target || {};
    mission.goal.target.kind = mission.goal.target.kind || 'source';
    mission.goal.target.roomName = mission.goal.target.roomName || mission.targetRoom || mission.sponsorRoom;
    mission.goal.target.id = mission.goal.target.id || mission.targetId;
    mission.goal.success = mission.goal.success || {};
    mission.goal.success.kind = mission.goal.success.kind || 'sustained_harvest';
    mission.goal.success.minAssignedPrimary = Number.isFinite(mission.goal.success.minAssignedPrimary)
        ? mission.goal.success.minAssignedPrimary
        : 1;
    mission.goal.persistWhile = mission.goal.persistWhile || {};
    if (mission.goal.persistWhile.sponsorOwned !== true) mission.goal.persistWhile.sponsorOwned = true;
    if (mission.goal.persistWhile.targetExistsWhenVisible !== true) mission.goal.persistWhile.targetExistsWhenVisible = true;
    mission.goal.completion = mission.goal.completion || 'never';
}

function buildPlanSignature(roomName, sourceId, mode, containerId, linkId, maxCount, budget) {
    const budgetBucket = Math.max(1, Math.floor((budget || 0) / 100));
    return [
        roomName,
        sourceId,
        mode,
        containerId || '-',
        linkId || '-',
        maxCount,
        budgetBucket
    ].join(':');
}

function getCachedHarvestPlan(signature) {
    const store = heap.getStore(HARVEST_PLAN_STORE, { ttl: HARVEST_PLAN_CACHE_TTL });
    const cached = store[signature];
    if (!cached || !Number.isFinite(cached.tick)) return null;
    if ((Game.time - cached.tick) > HARVEST_PLAN_REPLAN_INTERVAL) return null;
    return cached;
}

function setCachedHarvestPlan(signature, plan) {
    const store = heap.getStore(HARVEST_PLAN_STORE, { ttl: HARVEST_PLAN_CACHE_TTL });
    store[signature] = Object.assign({ tick: Game.time }, plan);
}

function shouldReplanMission(mission, signature) {
    const meta = mission.meta || {};
    if (!meta.planSignature) return true;
    if (meta.planSignature !== signature) return true;
    if (!Number.isFinite(meta.planTick)) return true;
    if ((Game.time - meta.planTick) >= HARVEST_PLAN_REPLAN_INTERVAL) return true;
    return !Array.isArray(meta.dropoffIds);
}

function updateProgressState(mission, planState) {
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

function buildFreshPlan(planCtx) {
    const dropoffIds = computeDropoffIds(planCtx.mode, planCtx.sourceInfo);
    const archStats = estimateMinerStatsForPlanning(planCtx.budget, planCtx.mode);
    const spawns = (planCtx.intel && planCtx.intel.structures && planCtx.intel.structures[STRUCTURE_SPAWN]) || planCtx.room.find(FIND_MY_SPAWNS);
    const travel = planCtx.source ? getHarvestTravelEstimate(planCtx.room, spawns, planCtx.source, archStats) : {
        sourceDistance: 0,
        travelTicks: 0,
        preSpawnLeadTicks: 0,
        travelFromSpawnId: null
    };

    return {
        mode: planCtx.mode,
        dropoffIds,
        fallback: 'none',
        dropoffRange: 1,
        sourceDistance: travel.sourceDistance,
        travelTicks: travel.travelTicks,
        preSpawnLeadTicks: travel.preSpawnLeadTicks,
        travelFromSpawnId: travel.travelFromSpawnId,
        staticRolesBySlot: buildStaticRolesBySlot(planCtx.mode, planCtx.maxCount),
        targetWork: 7,
        maxCount: planCtx.maxCount
    };
}

function refreshMissionData(mission, runtimeCtx) {
    const roomName = mission.targetRoom || mission.sponsorRoom;
    const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
    if (!room) return 'cached';
    const intel = runtimeCtx ? runtimeCtx.intel : null;
    const context = runtimeCtx ? runtimeCtx.context : null;

    const source = Game.getObjectById(mission.targetId);
    const sourceInfo = getSourceInfo(intel, mission.targetId);
    const mode = computeHarvestMode(sourceInfo || { id: mission.targetId });
    const containerId = sourceInfo && sourceInfo.containerId ? sourceInfo.containerId : null;
    const linkId = sourceInfo && sourceInfo.linkId ? sourceInfo.linkId : null;
    const maxCount = Math.max(1, (sourceInfo && sourceInfo.availableSpaces) || 1);
    const budget = context && Number.isFinite(context.budget) ? context.budget : room.energyCapacityAvailable;
    const planSignature = buildPlanSignature(room.name, mission.targetId, mode, containerId, linkId, maxCount, budget);

    let planState = 'cached';
    let plan = null;
    if (shouldReplanMission(mission, planSignature)) {
        const cachedPlan = getCachedHarvestPlan(planSignature);
        if (cachedPlan) {
            plan = cachedPlan;
            planState = 'cache_hit';
        } else {
            plan = buildFreshPlan({
                room,
                intel,
                source,
                sourceInfo,
                mode,
                budget,
                maxCount
            });
            setCachedHarvestPlan(planSignature, plan);
            planState = 'replanned';
        }
    } else {
        plan = {
            mode: mission.meta && mission.meta.mode ? mission.meta.mode : mode,
            dropoffIds: mission.meta && Array.isArray(mission.meta.dropoffIds) ? mission.meta.dropoffIds : [],
            fallback: mission.meta && mission.meta.fallback ? mission.meta.fallback : 'none',
            dropoffRange: mission.meta && Number.isFinite(mission.meta.dropoffRange) ? mission.meta.dropoffRange : 1,
            sourceDistance: mission.meta && Number.isFinite(mission.meta.sourceDistance) ? mission.meta.sourceDistance : 0,
            travelTicks: mission.meta && Number.isFinite(mission.meta.travelTicks) ? mission.meta.travelTicks : 0,
            preSpawnLeadTicks: mission.meta && Number.isFinite(mission.meta.preSpawnLeadTicks) ? mission.meta.preSpawnLeadTicks : 0,
            travelFromSpawnId: mission.meta && mission.meta.travelFromSpawnId ? mission.meta.travelFromSpawnId : null,
            staticRolesBySlot: mission.meta && mission.meta.staticRolesBySlot ? mission.meta.staticRolesBySlot : {},
            targetWork: mission.meta && Number.isFinite(mission.meta.targetWork) ? mission.meta.targetWork : 7,
            maxCount
        };
    }

    mission.requirements = {
        archetype: 'miner',
        requiredWork: plan.targetWork,
        minCount: 1,
        maxCount
    };
    mission.spawnSlots = buildSpawnSlots(room.name, mission.targetId, maxCount);
    mission.meta = mission.meta || {};
    mission.meta.containerId = containerId;
    mission.meta.linkId = linkId;
    mission.meta.mode = plan.mode;
    mission.meta.dropoffIds = plan.dropoffIds;
    mission.meta.fallback = plan.fallback;
    mission.meta.dropoffRange = plan.dropoffRange;
    mission.meta.sourceDistance = plan.sourceDistance;
    mission.meta.travelTicks = plan.travelTicks;
    mission.meta.preSpawnLeadTicks = plan.preSpawnLeadTicks;
    mission.meta.travelFromSpawnId = plan.travelFromSpawnId;
    mission.meta.maxCount = maxCount;
    mission.meta.targetWork = plan.targetWork;
    mission.meta.staticRolesBySlot = plan.staticRolesBySlot;
    mission.meta.planSignature = planSignature;
    if (planState !== 'cached') mission.meta.planTick = Game.time;
    mission.meta.lastKnownRoom = room.name;
    if (source && source.pos) {
        mission.meta.sourcePos = { x: source.pos.x, y: source.pos.y, roomName: source.pos.roomName };
    } else if (sourceInfo && sourceInfo.pos && sourceInfo.pos.roomName) {
        mission.meta.sourcePos = { x: sourceInfo.pos.x, y: sourceInfo.pos.y, roomName: sourceInfo.pos.roomName };
    }
    mission.demand = {
        role: 'miner',
        count: Math.max(0, 1 - mission.assigned.primary.length),
        bodyProfile: 'miner_static'
    };
    return planState;
}

module.exports = {
    makeKey(context) {
        const roomName = context.targetRoom || context.sponsorRoom;
        return missionKeys.makeHarvestKey(roomName, context.sourceId);
    },

    reconcileRoom({ room, intel, context, missionBoard }) {
        if (!room || !missionBoard) return;
        if (!missionThrottle.shouldRunReconcile('harvest', room.name, Game.time)) return;
        if (!shouldActivateHarvest(room, intel)) return;

        const sources = intel && Array.isArray(intel.sources)
            ? intel.sources
            : room.find(FIND_SOURCES).map(s => ({ id: s.id, availableSpaces: 1 }));
        const simpleHarvestAnchorSourceId = shouldUseHybridEarlyHarvest(room, intel)
            ? pickSimpleHarvestAnchorSourceId(room, intel)
            : null;

        for (let i = 0; i < sources.length; i++) {
            const source = sources[i];
            if (!source || !source.id) continue;
            if (simpleHarvestAnchorSourceId && source.id === simpleHarvestAnchorSourceId) continue;
            missionBoard.createMission('harvest', {
                sponsorRoom: room.name,
                targetRoom: room.name,
                sourceId: source.id,
                availableSpaces: source.availableSpaces,
                priority: context && context.opState === 'EMERGENCY' ? 1000 : 100
            }, { room, intel, context });
        }
    },

    create(context) {
        const now = Game.time;
        return {
            id: this.makeKey(context),
            key: this.makeKey(context),
            type: 'harvest',
            class: missionClasses.SERVICE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.targetRoom || context.sponsorRoom,
            priority: Number.isFinite(context.priority) ? context.priority : 100,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: context.sourceId,
            assigned: { primary: [], support: [] },
            demand: { role: 'miner', count: 1, bodyProfile: 'miner_static' },
            goal: {
                kind: 'service',
                target: {
                    kind: 'source',
                    roomName: context.targetRoom || context.sponsorRoom,
                    id: context.sourceId
                },
                success: {
                    kind: 'sustained_harvest',
                    minAssignedPrimary: 1
                },
                persistWhile: {
                    sponsorOwned: true,
                    targetExistsWhenVisible: true
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
                missionName: `harvest:${context.sourceId}`
            },
            statusReason: null
        };
    },

    validate(mission, runtimeCtx) {
        const sponsor = Game.rooms[mission.sponsorRoom];
        if (sponsor && sponsor.controller && !sponsor.controller.my) return false;

        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        if (!room) return true;
        if (!shouldActivateHarvest(room, runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null)) return false;

        const source = Game.getObjectById(mission.targetId);
        return !!source;
    },

    refresh(mission, runtimeCtx) {
        updateAssignmentState(mission);
        ensureGoalContract(mission);
        const planState = refreshMissionData(mission, runtimeCtx);
        updateProgressState(mission, planState);
    },

    isComplete() {
        return false;
    },

    getDemand(mission) {
        updateAssignmentState(mission);
        const needed = Math.max(0, 1 - mission.assigned.primary.length);
        return {
            role: 'miner',
            count: needed,
            priority: mission.priority || 80
        };
    },

    toContractMission(mission) {
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const sourcePos = mission.meta && mission.meta.sourcePos
            ? new RoomPosition(mission.meta.sourcePos.x, mission.meta.sourcePos.y, mission.meta.sourcePos.roomName)
            : null;
        return {
            name: mission.meta && mission.meta.missionName ? mission.meta.missionName : `harvest:${mission.targetId}`,
            type: 'harvest',
            archetype: 'miner',
            sourceId: mission.targetId,
            pos: sourcePos,
            requirements: mission.requirements || {
                archetype: 'miner',
                requiredWork: 7,
                minCount: 1,
                maxCount: 1
            },
            spawnSlots: mission.spawnSlots || buildSpawnSlots(roomName, mission.targetId, 1),
            data: {
                sourceId: mission.targetId,
                mode: mission.meta && mission.meta.mode ? mission.meta.mode : 'static_drop',
                dropoffIds: mission.meta && Array.isArray(mission.meta.dropoffIds) ? mission.meta.dropoffIds : [],
                fallback: mission.meta && mission.meta.fallback ? mission.meta.fallback : 'none',
                containerId: mission.meta && mission.meta.containerId ? mission.meta.containerId : null,
                dropoffRange: mission.meta && Number.isFinite(mission.meta.dropoffRange) ? mission.meta.dropoffRange : 1,
                staticRolesBySlot: mission.meta && mission.meta.staticRolesBySlot ? mission.meta.staticRolesBySlot : {},
                overflowPolicy: 'drop',
                sourceDistance: mission.meta && Number.isFinite(mission.meta.sourceDistance) ? mission.meta.sourceDistance : 0,
                travelTicks: mission.meta && Number.isFinite(mission.meta.travelTicks) ? mission.meta.travelTicks : 0,
                preSpawnLeadTicks: mission.meta && Number.isFinite(mission.meta.preSpawnLeadTicks) ? mission.meta.preSpawnLeadTicks : 0,
                travelFromSpawnId: mission.meta && mission.meta.travelFromSpawnId ? mission.meta.travelFromSpawnId : null
            },
            priority: mission.priority || 100
        };
    }
};




