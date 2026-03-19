const heap = require('utils_heap');
const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');

const SIMPLE_HARVEST_TRAVEL_CACHE_TTL = 200;
const SIMPLE_HARVEST_TRAVEL_STORE = 'simpleHarvestTravel';
const SIMPLE_HARVEST_PLAN_CACHE_TTL = 250;
const SIMPLE_HARVEST_PLAN_STORE = 'simpleHarvestPlan';
const SIMPLE_HARVEST_REPLAN_INTERVAL = 101;

function getSourceAnchorPos(room, source) {
    if (!room || !source || !source.pos) return null;

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

function estimateMobileMinerStats(budget) {
    const segments = Math.max(1, Math.floor((budget || 0) / 250));
    const work = Math.min(5, segments);
    const move = Math.max(2, segments * 2);
    const carry = Math.max(1, segments);
    return { work, move, carry, bodyLen: work + move + carry };
}

function getTravelEstimate(room, spawns, source, archStats) {
    if (!room || !source || !source.id || !spawns || spawns.length === 0) {
        return {
            sourceDistance: 0,
            travelTicks: 0,
            preSpawnLeadTicks: 0,
            travelFromSpawnId: null
        };
    }

    const store = heap.getStore(SIMPLE_HARVEST_TRAVEL_STORE, { ttl: SIMPLE_HARVEST_TRAVEL_CACHE_TTL });
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

function hasNonMiningContainer(room, intel) {
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

function shouldActivateSimpleHarvest(room, intel) {
    if (!room || !room.controller || !room.controller.my) return false;
    if (room.storage) return false;
    return !hasNonMiningContainer(room, intel);
}

function pickSimpleHarvestSource(room, intel) {
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

    return best;
}

function computeDropoffIds(room, intel) {
    const spawns = (intel && intel.structures && intel.structures[STRUCTURE_SPAWN]) || room.find(FIND_MY_SPAWNS);
    const extensions = (intel && intel.structures && intel.structures[STRUCTURE_EXTENSION]) || room.find(FIND_MY_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_EXTENSION
    });

    const spawnIds = spawns
        .filter(s => s && s.store && (s.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 0)
        .map(s => s.id);
    const extensionIds = extensions
        .filter(e => e && e.store && (e.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 0)
        .map(e => e.id);

    const miningContainerIds = getMiningContainerIdSet(intel);
    const containers = (intel && intel.structures && intel.structures[STRUCTURE_CONTAINER])
        ? intel.structures[STRUCTURE_CONTAINER]
        : room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER });
    const nonMiningContainerIds = containers
        .filter(c => c && c.id && !miningContainerIds.has(c.id) && c.store && (c.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 0)
        .map(c => c.id);

    return [...spawnIds, ...extensionIds, ...nonMiningContainerIds];
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
        slots.push(`simpleHarvest:${roomName}:${sourceId}:${i}`);
    }
    return slots;
}

function buildGoalContract(mission) {
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
        mission.goal = buildGoalContract(mission);
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

function buildPlanSignature(roomName, sourceId, dropoffIds, budget) {
    const budgetBucket = Math.max(1, Math.floor((budget || 0) / 100));
    const dropoffSig = Array.isArray(dropoffIds) && dropoffIds.length > 0 ? dropoffIds.join(',') : '-';
    return [roomName, sourceId, dropoffSig, budgetBucket].join(':');
}

function getCachedPlan(signature) {
    const store = heap.getStore(SIMPLE_HARVEST_PLAN_STORE, { ttl: SIMPLE_HARVEST_PLAN_CACHE_TTL });
    const cached = store[signature];
    if (!cached || !Number.isFinite(cached.tick)) return null;
    if ((Game.time - cached.tick) > SIMPLE_HARVEST_REPLAN_INTERVAL) return null;
    return cached;
}

function setCachedPlan(signature, plan) {
    const store = heap.getStore(SIMPLE_HARVEST_PLAN_STORE, { ttl: SIMPLE_HARVEST_PLAN_CACHE_TTL });
    store[signature] = Object.assign({ tick: Game.time }, plan);
}

function shouldReplanMission(mission, signature) {
    const meta = mission.meta || {};
    if (!meta.planSignature) return true;
    if (meta.planSignature !== signature) return true;
    if (!Number.isFinite(meta.planTick)) return true;
    if ((Game.time - meta.planTick) >= SIMPLE_HARVEST_REPLAN_INTERVAL) return true;
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
    const archStats = estimateMobileMinerStats(planCtx.budget);
    const spawns = (planCtx.intel && planCtx.intel.structures && planCtx.intel.structures[STRUCTURE_SPAWN]) || planCtx.room.find(FIND_MY_SPAWNS);
    const travel = planCtx.source ? getTravelEstimate(planCtx.room, spawns, planCtx.source, archStats) : {
        sourceDistance: 0,
        travelTicks: 0,
        preSpawnLeadTicks: 0,
        travelFromSpawnId: null
    };

    return {
        mode: 'mobile',
        dropoffIds: planCtx.dropoffIds,
        fallback: 'upgrade',
        dropoffRange: 1,
        sourceDistance: travel.sourceDistance,
        travelTicks: travel.travelTicks,
        preSpawnLeadTicks: travel.preSpawnLeadTicks,
        travelFromSpawnId: travel.travelFromSpawnId,
        staticRolesBySlot: {},
        targetWork: 5,
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
    const maxCount = 3;
    const budget = context && Number.isFinite(context.budget) ? context.budget : room.energyCapacityAvailable;
    const dropoffIds = computeDropoffIds(room, intel);
    const planSignature = buildPlanSignature(room.name, mission.targetId, dropoffIds, budget);

    let planState = 'cached';
    let plan = null;
    if (shouldReplanMission(mission, planSignature)) {
        const cachedPlan = getCachedPlan(planSignature);
        if (cachedPlan) {
            plan = cachedPlan;
            planState = 'cache_hit';
        } else {
            plan = buildFreshPlan({
                room,
                intel,
                source,
                sourceInfo,
                budget,
                dropoffIds,
                maxCount
            });
            setCachedPlan(planSignature, plan);
            planState = 'replanned';
        }
    } else {
        plan = {
            mode: 'mobile',
            dropoffIds: mission.meta && Array.isArray(mission.meta.dropoffIds) ? mission.meta.dropoffIds : dropoffIds,
            fallback: 'upgrade',
            dropoffRange: mission.meta && Number.isFinite(mission.meta.dropoffRange) ? mission.meta.dropoffRange : 1,
            sourceDistance: mission.meta && Number.isFinite(mission.meta.sourceDistance) ? mission.meta.sourceDistance : 0,
            travelTicks: mission.meta && Number.isFinite(mission.meta.travelTicks) ? mission.meta.travelTicks : 0,
            preSpawnLeadTicks: mission.meta && Number.isFinite(mission.meta.preSpawnLeadTicks) ? mission.meta.preSpawnLeadTicks : 0,
            travelFromSpawnId: mission.meta && mission.meta.travelFromSpawnId ? mission.meta.travelFromSpawnId : null,
            staticRolesBySlot: {},
            targetWork: mission.meta && Number.isFinite(mission.meta.targetWork) ? mission.meta.targetWork : 5,
            maxCount
        };
    }

    mission.requirements = {
        archetype: 'simple_miner',
        requiredWork: plan.targetWork,
        minCount: 1,
        maxCount
    };
    mission.spawnSlots = buildSpawnSlots(room.name, mission.targetId, maxCount);
    mission.meta = mission.meta || {};
    mission.meta.containerId = null;
    mission.meta.linkId = null;
    mission.meta.mode = 'mobile';
    mission.meta.dropoffIds = plan.dropoffIds;
    mission.meta.fallback = 'upgrade';
    mission.meta.dropoffRange = plan.dropoffRange;
    mission.meta.sourceDistance = plan.sourceDistance;
    mission.meta.travelTicks = plan.travelTicks;
    mission.meta.preSpawnLeadTicks = plan.preSpawnLeadTicks;
    mission.meta.travelFromSpawnId = plan.travelFromSpawnId;
    mission.meta.maxCount = maxCount;
    mission.meta.targetWork = plan.targetWork;
    mission.meta.staticRolesBySlot = {};
    mission.meta.planSignature = planSignature;
    if (planState !== 'cached') mission.meta.planTick = Game.time;
    mission.meta.lastKnownRoom = room.name;
    if (source && source.pos) {
        mission.meta.sourcePos = { x: source.pos.x, y: source.pos.y, roomName: source.pos.roomName };
    } else if (sourceInfo && sourceInfo.pos && sourceInfo.pos.roomName) {
        mission.meta.sourcePos = { x: sourceInfo.pos.x, y: sourceInfo.pos.y, roomName: sourceInfo.pos.roomName };
    }

    mission.demand = {
        role: 'simple_miner',
        count: Math.max(0, 1 - mission.assigned.primary.length),
        bodyProfile: 'miner_mobile'
    };

    return planState;
}

module.exports = {
    makeKey(context) {
        const roomName = context.targetRoom || context.sponsorRoom;
        return missionKeys.makeUserMissionKey(roomName, 'simpleHarvest', context.sourceId, 'source');
    },

    reconcileRoom({ room, intel, context, missionBoard }) {
        if (!room || !missionBoard) return;
        if (!missionThrottle.shouldRunReconcile('simpleHarvest', room.name, Game.time)) return;
        if (!shouldActivateSimpleHarvest(room, intel)) return;

        const source = pickSimpleHarvestSource(room, intel);
        if (!source || !source.id) return;

        missionBoard.createMission('simpleHarvest', {
            sponsorRoom: room.name,
            targetRoom: room.name,
            sourceId: source.id,
            availableSpaces: source.availableSpaces,
            priority: context && context.opState === 'EMERGENCY' ? 1000 : 120
        }, { room, intel, context });
    },

    create(context) {
        const now = Game.time;
        return {
            id: this.makeKey(context),
            key: this.makeKey(context),
            type: 'simpleHarvest',
            class: missionClasses.SERVICE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.targetRoom || context.sponsorRoom,
            priority: Number.isFinite(context.priority) ? context.priority : 120,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: context.sourceId,
            assigned: { primary: [], support: [] },
            demand: { role: 'simple_miner', count: 1, bodyProfile: 'miner_mobile' },
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
                missionName: `simpleHarvest:${context.sourceId}`
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
        if (!shouldActivateSimpleHarvest(room, runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null)) return false;

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
            role: 'simple_miner',
            count: needed,
            priority: mission.priority || 90
        };
    },

    toContractMission(mission) {
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const sourcePos = mission.meta && mission.meta.sourcePos
            ? new RoomPosition(mission.meta.sourcePos.x, mission.meta.sourcePos.y, mission.meta.sourcePos.roomName)
            : null;
        return {
            name: mission.meta && mission.meta.missionName ? mission.meta.missionName : `simpleHarvest:${mission.targetId}`,
            type: 'simple_harvest',
            archetype: 'simple_miner',
            sourceId: mission.targetId,
            pos: sourcePos,
            requirements: mission.requirements || {
                archetype: 'simple_miner',
                requiredWork: 5,
                minCount: 1,
                maxCount: 1
            },
            spawnSlots: mission.spawnSlots || buildSpawnSlots(roomName, mission.targetId, 1),
            data: {
                sourceId: mission.targetId,
                mode: 'mobile',
                dropoffIds: mission.meta && Array.isArray(mission.meta.dropoffIds) ? mission.meta.dropoffIds : [],
                fallback: 'upgrade',
                containerId: null,
                dropoffRange: mission.meta && Number.isFinite(mission.meta.dropoffRange) ? mission.meta.dropoffRange : 1,
                staticRolesBySlot: {},
                overflowPolicy: 'drop',
                sourceDistance: mission.meta && Number.isFinite(mission.meta.sourceDistance) ? mission.meta.sourceDistance : 0,
                travelTicks: mission.meta && Number.isFinite(mission.meta.travelTicks) ? mission.meta.travelTicks : 0,
                preSpawnLeadTicks: mission.meta && Number.isFinite(mission.meta.preSpawnLeadTicks) ? mission.meta.preSpawnLeadTicks : 0,
                travelFromSpawnId: mission.meta && mission.meta.travelFromSpawnId ? mission.meta.travelFromSpawnId : null
            },
            priority: mission.priority || 120
        };
    }
};
