const heap = require('utils_heap');
const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');

const MAX_HAULER_CARRY_PARTS = 25;
const MIN_CARRY_PER_SOURCE = 5;
const LINKED_SOURCE_MIN_CARRY = 3;
const ENERGY_PER_TICK = 10;
const TRANSFER_BUFFER_TICKS = 2;
const DISTANCE_SOFT_CAP = 17;
const DISTANCE_SCALE_PER_TILE = 0.1;
const EARLY_GAME_ENERGY_CAP = 500;
const EARLY_GAME_HAULER_MULTIPLIER = 1.01;
const LINK_SOURCE_RANGE = 2;
const LINK_RECEIVER_RANGE = 3;
const LOGISTICS_FLEET_REPLAN_INTERVAL = 79;
const LOGISTICS_FLEET_PLAN_CACHE_TTL = 200;
const LOGISTICS_FLEET_PLAN_STORE = 'logisticsFleetPlan';

function cleanupAssigned(mission) {
    if (!mission.assigned) mission.assigned = { primary: [], support: [] };
    if (!Array.isArray(mission.assigned.primary)) mission.assigned.primary = [];
    mission.assigned.primary = mission.assigned.primary.filter(name => !!Game.creeps[name]);
}

function buildGoalContract(mission) {
    return {
        kind: 'service',
        target: {
            kind: 'room_logistics_fleet',
            roomName: mission.targetRoom || mission.sponsorRoom
        },
        success: {
            kind: 'carry_capacity_meets_demand',
            metric: 'requiredCarry'
        },
        persistWhile: {
            sponsorOwned: true
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
    mission.goal.target.kind = mission.goal.target.kind || 'room_logistics_fleet';
    mission.goal.target.roomName = mission.goal.target.roomName || mission.targetRoom || mission.sponsorRoom;
    mission.goal.success = mission.goal.success || {};
    mission.goal.success.kind = mission.goal.success.kind || 'carry_capacity_meets_demand';
    mission.goal.success.metric = mission.goal.success.metric || 'requiredCarry';
    mission.goal.persistWhile = mission.goal.persistWhile || {};
    if (mission.goal.persistWhile.sponsorOwned !== true) mission.goal.persistWhile.sponsorOwned = true;
    mission.goal.completion = mission.goal.completion || 'never';
}

function getIntelSourcesSignature(intel, efficientSources) {
    const parts = [];
    const sources = intel && Array.isArray(intel.sources) ? intel.sources : [];
    for (let i = 0; i < sources.length; i++) {
        const s = sources[i];
        if (!s || !s.id) continue;
        if (efficientSources && efficientSources.size > 0 && !efficientSources.has(s.id)) continue;
        parts.push(`${s.id}:${s.containerId || '-'}:${s.linkId || '-'}`);
    }
    parts.sort();
    return parts.join('|');
}

function buildPlanSignature(room, intel, context) {
    const efficientSources = context && context.efficientSources ? context.efficientSources : null;
    const budget = Number.isFinite(context && context.budget) ? context.budget : (room && room.energyCapacityAvailable) || 300;
    const budgetBucket = Math.max(1, Math.floor(budget / 100));
    const storageId = room && room.storage ? room.storage.id : '-';
    const spawns = intel && intel.structures && Array.isArray(intel.structures[STRUCTURE_SPAWN])
        ? intel.structures[STRUCTURE_SPAWN].map(s => s.id).sort()
        : [];
    const spawnSig = spawns.join(',');
    const sourceSig = getIntelSourcesSignature(intel, efficientSources);
    return `${room.name}:${storageId}:${spawnSig}:${sourceSig}:b${budgetBucket}`;
}

function getCachedPlan(signature) {
    const store = heap.getStore(LOGISTICS_FLEET_PLAN_STORE, { ttl: LOGISTICS_FLEET_PLAN_CACHE_TTL });
    const cached = store[signature];
    if (!cached || !Number.isFinite(cached.tick)) return null;
    if ((Game.time - cached.tick) > LOGISTICS_FLEET_REPLAN_INTERVAL) return null;
    return cached.plan || null;
}

function setCachedPlan(signature, plan) {
    const store = heap.getStore(LOGISTICS_FLEET_PLAN_STORE, { ttl: LOGISTICS_FLEET_PLAN_CACHE_TTL });
    store[signature] = { tick: Game.time, plan: plan || null };
}

function shouldReplan(mission, signature) {
    const meta = mission.meta || {};
    if (!meta.planSignature) return true;
    if (meta.planSignature !== signature) return true;
    if (!Number.isFinite(meta.planTick)) return true;
    return (Game.time - meta.planTick) >= LOGISTICS_FLEET_REPLAN_INTERVAL;
}

function applyFleetPlan(mission, room, fleet) {
    mission.meta = mission.meta || {};
    mission.meta.legacyName = mission.meta.legacyName || 'logistics:fleet';

    if (!fleet) {
        mission.meta.carryParts = Math.max(1, Math.floor((room.energyCapacityAvailable || 300) / 100));
        mission.requirements = {
            archetype: 'hauler',
            requiredCarry: 0,
            minCount: 0,
            maxCount: 0,
            spawnFromFleet: true,
            maxCarryParts: MAX_HAULER_CARRY_PARTS
        };
        mission.demand = { role: 'hauler', count: 0, bodyProfile: 'hauler' };
        return;
    }

    mission.meta.carryParts = fleet.carryParts;
    mission.meta.sourceCount = fleet.sourceCount;
    mission.meta.linkedSourcesCount = fleet.linkedSourcesCount;
    mission.meta.earlyGame = fleet.earlyGame;
    mission.requirements = {
        archetype: 'hauler',
        requiredCarry: fleet.requiredCarry,
        minCount: fleet.minCount,
        maxCount: fleet.maxCount,
        spawnFromFleet: true,
        maxCarryParts: MAX_HAULER_CARRY_PARTS
    };

    const assignedCount = mission.assigned.primary.length;
    mission.demand = {
        role: 'hauler',
        count: Math.max(0, fleet.minCount - assignedCount),
        bodyProfile: 'hauler'
    };
    if (assignedCount > 0) mission.lastProgressTick = Game.time;
}

function updateProgress(mission, planState) {
    mission.progress = mission.progress || {};
    mission.progress.stage = 'fleet';
    mission.progress.goalState = mission.assigned.primary.length > 0 ? 'sustaining' : 'seeking_assignment';
    mission.progress.planState = planState || 'cached';
    mission.progress.assignedPrimary = mission.assigned.primary.length;
    mission.progress.lastPlanTick = mission.meta && Number.isFinite(mission.meta.planTick)
        ? mission.meta.planTick
        : 0;
}

function calculateFleet(room, intel, context) {
    const efficientSources = context && context.efficientSources ? context.efficientSources : null;
    if (!efficientSources || efficientSources.size <= 0) return null;

    const budget = Number.isFinite(context && context.budget) ? context.budget : intel.energyCapacityAvailable;
    const uncappedCarryParts = Math.max(1, Math.floor((budget || 0) / 100));
    const carryParts = Math.min(uncappedCarryParts, MAX_HAULER_CARRY_PARTS);

    const miningContainerIds = new Set((intel.sources || []).map(s => s.containerId).filter(id => !!id));
    const allContainers = intel.structures[STRUCTURE_CONTAINER] || [];
    const miningContainers = allContainers.filter(c => miningContainerIds.has(c.id));
    const miningContainersById = new Map(miningContainers.map(c => [c.id, c]));
    const spawns = intel.structures[STRUCTURE_SPAWN] || [];
    const storage = room.storage;
    const haulTargets = storage ? [storage] : spawns;
    if (haulTargets.length === 0) return null;

    const links = intel.structures[STRUCTURE_LINK] || [];
    const hasReceiverLink = links.some(link =>
        (storage && link.pos.inRangeTo(storage.pos, LINK_RECEIVER_RANGE)) ||
        spawns.some(spawn => link.pos.inRangeTo(spawn.pos, LINK_RECEIVER_RANGE))
    );

    const sourcesWithLink = new Set();
    if (hasReceiverLink && links.length > 0) {
        for (let i = 0; i < intel.sources.length; i++) {
            const source = intel.sources[i];
            if (!source || !source.pos) continue;
            if (links.some(link => link.pos.inRangeTo(source.pos, LINK_SOURCE_RANGE))) {
                sourcesWithLink.add(source.id);
            }
        }
    }

    const pathLengthCache = new Map();
    const getPathLength = (fromPos, toPos) => {
        const key = `${fromPos.x},${fromPos.y}:${toPos.x},${toPos.y}`;
        if (pathLengthCache.has(key)) return pathLengthCache.get(key);

        const result = PathFinder.search(fromPos, { pos: toPos, range: 1 }, {
            maxOps: 2000,
            plainCost: 2,
            swampCost: 10
        });

        const length = result.incomplete ? fromPos.getRangeTo(toPos) : result.path.length;
        pathLengthCache.set(key, length);
        return length;
    };

    const getClosestByPath = (fromPos, targets) => {
        let best = null;
        let bestLen = Infinity;
        for (let i = 0; i < targets.length; i++) {
            const t = targets[i];
            const len = getPathLength(fromPos, t.pos);
            if (len < bestLen) {
                bestLen = len;
                best = t;
            }
        }
        return best;
    };

    const root = heap.getStore('fleetLogisticsPathCache');
    if (!root.rooms) root.rooms = Object.create(null);

    const cache = root.rooms[room.name] || (root.rooms[room.name] = {
        targetSignature: null,
        paths: Object.create(null),
        lastPrune: 0
    });

    const targetSignature = storage
        ? `storage:${storage.id}`
        : `spawns:${spawns.map(s => s.id).sort().join(',')}`;

    if (cache.targetSignature !== targetSignature) {
        cache.targetSignature = targetSignature;
        cache.paths = Object.create(null);
    }

    const getCachedPath = pickupId => cache.paths[pickupId];
    const setCachedPath = (pickupId, entry) => { cache.paths[pickupId] = entry; };
    const usedPickupIds = new Set();

    let totalRequiredCarryParts = 0;
    let linkedSourcesCount = 0;

    for (let i = 0; i < intel.sources.length; i++) {
        const source = intel.sources[i];
        if (!source || !efficientSources.has(source.id)) continue;

        const container = source.containerId ? miningContainersById.get(source.containerId) : null;
        const pickupPos = container ? container.pos : source.pos;
        if (!pickupPos) continue;

        const pickupId = container ? container.id : source.id;
        usedPickupIds.add(pickupId);

        const isLinkedSource = sourcesWithLink.has(source.id);
        if (isLinkedSource) linkedSourcesCount += 1;

        let requiredCarry = LINKED_SOURCE_MIN_CARRY;
        const cached = getCachedPath(pickupId);
        const cachedTarget = cached ? Game.getObjectById(cached.targetId) : null;
        const useCached = !!cached &&
            cached.pickupId === pickupId &&
            cachedTarget &&
            cached.targetSignature === targetSignature;

        if (!isLinkedSource) {
            let pathLen = 1;
            if (useCached) {
                pathLen = cached.pathLen;
            } else {
                const dropoff = storage ? storage : getClosestByPath(pickupPos, haulTargets);
                pathLen = dropoff ? getPathLength(pickupPos, dropoff.pos) : 1;
                if (dropoff) {
                    setCachedPath(pickupId, {
                        pickupId,
                        targetId: dropoff.id,
                        pathLen,
                        targetSignature
                    });
                }
            }

            const roundTrip = (pathLen * 2) + TRANSFER_BUFFER_TICKS;
            const distanceScale = 1 + Math.max(0, pathLen - DISTANCE_SOFT_CAP) * DISTANCE_SCALE_PER_TILE;
            requiredCarry = Math.ceil((ENERGY_PER_TICK * roundTrip * distanceScale) / 50);
        }

        const minCarry = isLinkedSource ? LINKED_SOURCE_MIN_CARRY : MIN_CARRY_PER_SOURCE;
        totalRequiredCarryParts += Math.max(minCarry, requiredCarry);
    }

    const PRUNE_EVERY = 500;
    const MAX_KEYS = 1000;
    if ((Game.time - (cache.lastPrune || 0)) >= PRUNE_EVERY) {
        cache.lastPrune = Game.time;
        for (const pickupId in cache.paths) {
            if (!usedPickupIds.has(pickupId)) delete cache.paths[pickupId];
        }
        const keys = Object.keys(cache.paths);
        if (keys.length > MAX_KEYS) {
            const removeN = keys.length - MAX_KEYS;
            for (let i = 0; i < removeN; i++) delete cache.paths[keys[i]];
        }
    }

    const isEarlyGame = (room.controller && room.controller.level < 2) ||
        (!storage && intel.energyCapacityAvailable <= EARLY_GAME_ENERGY_CAP);
    const scaledRequiredCarryParts = isEarlyGame
        ? Math.ceil(totalRequiredCarryParts * EARLY_GAME_HAULER_MULTIPLIER)
        : totalRequiredCarryParts;

    const minHaulers = Math.max(2, efficientSources.size);
    const desiredHaulers = Math.max(minHaulers, Math.ceil(scaledRequiredCarryParts / carryParts));

    return {
        requiredCarry: scaledRequiredCarryParts,
        minCount: minHaulers,
        maxCount: desiredHaulers,
        carryParts,
        linkedSourcesCount,
        sourceCount: efficientSources.size,
        earlyGame: isEarlyGame
    };
}

module.exports = {
    makeKey(context) {
        return missionKeys.makeLogisticsFleetKey(context.targetRoom || context.sponsorRoom);
    },

    create(context) {
        const now = Game.time;
        return {
            id: this.makeKey(context),
            key: this.makeKey(context),
            type: 'logisticsFleet',
            class: missionClasses.SERVICE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.targetRoom || context.sponsorRoom,
            priority: Number.isFinite(context.priority) ? context.priority : 85,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: null,
            assigned: { primary: [], support: [] },
            demand: { role: 'hauler', count: 0, bodyProfile: 'hauler' },
            goal: {
                kind: 'service',
                target: {
                    kind: 'room_logistics_fleet',
                    roomName: context.targetRoom || context.sponsorRoom
                },
                success: {
                    kind: 'carry_capacity_meets_demand',
                    metric: 'requiredCarry'
                },
                persistWhile: {
                    sponsorOwned: true
                },
                completion: 'never'
            },
            progress: {
                stage: 'fleet',
                goalState: 'seeking_assignment',
                planState: 'pending',
                assignedPrimary: 0,
                lastPlanTick: 0
            },
            meta: {
                legacyName: 'logistics:fleet',
                carryParts: 5
            },
            statusReason: null
        };
    },

    validate(mission, runtimeCtx) {
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        if (!room || !room.controller || !room.controller.my) return false;
        return true;
    },

    refresh(mission, runtimeCtx) {
        cleanupAssigned(mission);
        ensureGoalContract(mission);

        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        const intel = runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null;
        const context = runtimeCtx && runtimeCtx.context ? runtimeCtx.context : null;

        if (!room || !intel || !Array.isArray(intel.sources)) {
            applyFleetPlan(mission, { energyCapacityAvailable: 300 }, null);
            updateProgress(mission, 'cached');
            return;
        }

        const signature = buildPlanSignature(room, intel, context);
        let planState = 'cached';
        let fleet = null;
        if (shouldReplan(mission, signature)) {
            const cached = getCachedPlan(signature);
            if (cached) {
                fleet = cached;
                planState = 'cache_hit';
            } else {
                fleet = calculateFleet(room, intel, context);
                setCachedPlan(signature, fleet);
                planState = 'replanned';
            }
        } else {
            fleet = {
                requiredCarry: mission.requirements && Number.isFinite(mission.requirements.requiredCarry)
                    ? mission.requirements.requiredCarry
                    : 0,
                minCount: mission.requirements && Number.isFinite(mission.requirements.minCount)
                    ? mission.requirements.minCount
                    : 0,
                maxCount: mission.requirements && Number.isFinite(mission.requirements.maxCount)
                    ? mission.requirements.maxCount
                    : 0,
                carryParts: mission.meta && Number.isFinite(mission.meta.carryParts) ? mission.meta.carryParts : 1,
                linkedSourcesCount: mission.meta && Number.isFinite(mission.meta.linkedSourcesCount)
                    ? mission.meta.linkedSourcesCount
                    : 0,
                sourceCount: mission.meta && Number.isFinite(mission.meta.sourceCount) ? mission.meta.sourceCount : 0,
                earlyGame: !!(mission.meta && mission.meta.earlyGame)
            };
        }
        mission.meta = mission.meta || {};
        mission.meta.planSignature = signature;
        if (planState !== 'cached') mission.meta.planTick = Game.time;
        applyFleetPlan(mission, room, fleet);
        updateProgress(mission, planState);

        if (typeof debug === 'function') {
            debug(
                'mission.logistics',
                `[LogisticsFleet] ${room.name} sources=${fleet.sourceCount} linkedSources=${fleet.linkedSourcesCount} ` +
                `carryPerHauler=${fleet.carryParts} requiredCarry=${fleet.requiredCarry} early=${fleet.earlyGame} desiredHaulers=${fleet.maxCount}`
            );
        }
    },

    isComplete() {
        return false;
    },

    toLegacyMission(mission) {
        const req = mission.requirements || {};
        return {
            name: mission.meta && mission.meta.legacyName ? mission.meta.legacyName : 'logistics:fleet',
            type: 'hauler_fleet',
            archetype: 'hauler',
            roleCensus: 'hauler',
            requirements: {
                archetype: 'hauler',
                requiredCarry: Number.isFinite(req.requiredCarry) ? req.requiredCarry : 0,
                minCount: Number.isFinite(req.minCount) ? req.minCount : 0,
                maxCount: Number.isFinite(req.maxCount) ? req.maxCount : 0,
                spawnFromFleet: true,
                maxCarryParts: Number.isFinite(req.maxCarryParts) ? req.maxCarryParts : MAX_HAULER_CARRY_PARTS
            },
            priority: Number.isFinite(mission.priority) ? mission.priority : 85
        };
    }
};
