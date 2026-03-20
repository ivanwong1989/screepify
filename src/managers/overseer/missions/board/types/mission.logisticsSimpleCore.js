const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');
const heap = require('utils_heap');

const CORE_END_FLAG = 'CORE_END';
const SIMPLE_CORE_TARGET_TYPES = new Set([
    STRUCTURE_SPAWN,
    STRUCTURE_EXTENSION,
    STRUCTURE_TOWER
]);
const TOWER_REFILL_MIN_FREE = 100;
const MAX_SIMPLE_HAULERS = 2;
const MIN_SIMPLE_CORE_HAULERS = 1;
const SIMPLE_CORE_PLAN_STORE = 'missionLogisticsSimpleCorePlan';
const SIMPLE_CORE_PLAN_CACHE_TTL = 30;
const SIMPLE_CORE_PLAN_REPLAN_INTERVAL = 5;

function shallowArrayEqual(a, b) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function shallowObjectEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
        const key = aKeys[i];
        if (a[key] !== b[key]) return false;
    }
    return true;
}

function setIfChanged(obj, key, value) {
    if (!obj) return false;
    if (obj[key] === value) return false;
    obj[key] = value;
    return true;
}

function setArrayIfChanged(obj, key, value) {
    if (!obj) return false;
    const next = Array.isArray(value) ? value : [];
    const prev = obj[key];
    if (shallowArrayEqual(prev, next)) return false;
    obj[key] = next.slice();
    return true;
}

function setObjectIfChanged(obj, key, value) {
    if (!obj) return false;
    const next = value && typeof value === 'object' ? value : {};
    const prev = obj[key];
    if (shallowObjectEqual(prev, next)) return false;
    obj[key] = Object.assign({}, next);
    return true;
}

function logSimpleCoreDebug(message) {
    if (typeof debug !== 'function') return;
    debug('mission.logistics', message);
}

function getRoomCache(room) {
    if (!room || typeof global.getRoomCache !== 'function') return null;
    return global.getRoomCache(room);
}

function getSimpleCoreRoomMemo(room, roomCache) {
    if (!room) {
        return {
            mySpawns: [],
            myStructures: [],
            dropped: [],
            tombstones: [],
            ruins: [],
            myLinks: [],
            objectById: Object.create(null)
        };
    }
    if (roomCache && roomCache._logisticsSimpleCoreMemo && roomCache._logisticsSimpleCoreMemo.time === Game.time) {
        return roomCache._logisticsSimpleCoreMemo;
    }

    const myStructures = roomCache && Array.isArray(roomCache.myStructures) ? roomCache.myStructures : room.find(FIND_MY_STRUCTURES);
    const myStructuresByType = roomCache && roomCache.myStructuresByType ? roomCache.myStructuresByType : Object.create(null);
    const mySpawns = Array.isArray(myStructuresByType[STRUCTURE_SPAWN])
        ? myStructuresByType[STRUCTURE_SPAWN]
        : room.find(FIND_MY_SPAWNS);
    const dropped = roomCache && Array.isArray(roomCache.dropped) ? roomCache.dropped : room.find(FIND_DROPPED_RESOURCES);
    const tombstones = roomCache && Array.isArray(roomCache.tombstones) ? roomCache.tombstones : room.find(FIND_TOMBSTONES);
    const ruins = roomCache && Array.isArray(roomCache.ruins) ? roomCache.ruins : room.find(FIND_RUINS);
    const myLinks = Array.isArray(myStructuresByType[STRUCTURE_LINK])
        ? myStructuresByType[STRUCTURE_LINK]
        : myStructures.filter(s => s && s.structureType === STRUCTURE_LINK);

    const objectById = Object.create(null);
    for (let i = 0; i < myStructures.length; i++) {
        const s = myStructures[i];
        if (s && s.id) objectById[s.id] = s;
    }
    for (let i = 0; i < dropped.length; i++) {
        const d = dropped[i];
        if (d && d.id) objectById[d.id] = d;
    }
    for (let i = 0; i < tombstones.length; i++) {
        const t = tombstones[i];
        if (t && t.id) objectById[t.id] = t;
    }
    for (let i = 0; i < ruins.length; i++) {
        const r = ruins[i];
        if (r && r.id) objectById[r.id] = r;
    }

    const memo = {
        time: Game.time,
        mySpawns,
        myStructures,
        dropped,
        tombstones,
        ruins,
        myLinks,
        objectById
    };
    if (roomCache) roomCache._logisticsSimpleCoreMemo = memo;
    return memo;
}

function getObjectByIdCached(id, objectCache, roomMemo) {
    if (!id) return null;
    if (objectCache && objectCache[id] !== undefined) return objectCache[id];
    if (roomMemo && roomMemo.objectById && roomMemo.objectById[id]) {
        if (objectCache) objectCache[id] = roomMemo.objectById[id];
        return roomMemo.objectById[id];
    }
    const obj = Game.getObjectById(id);
    if (objectCache) objectCache[id] = obj || null;
    return obj;
}

function cleanupAssigned(mission) {
    if (!mission.assigned) mission.assigned = { primary: [], support: [] };
    if (!Array.isArray(mission.assigned.primary)) mission.assigned.primary = [];
    const primary = mission.assigned.primary;
    let hasDead = false;
    for (let i = 0; i < primary.length; i++) {
        if (!Game.creeps[primary[i]]) {
            hasDead = true;
            break;
        }
    }
    if (!hasDead) return;

    const alive = [];
    const removed = [];
    for (let i = 0; i < primary.length; i++) {
        const name = primary[i];
        if (Game.creeps[name]) alive.push(name);
        else removed.push(name);
    }
    mission.assigned.primary = alive;
    if (removed.length > 0) {
        logSimpleCoreDebug(
            `[SimpleCore] ${mission.targetRoom || mission.sponsorRoom} cleanup staleAssigned=${removed.join(',') || '-'}`
        );
    }
}

function hasCoreLaneFlag(room) {
    if (!room) return false;
    const flag = Game.flags[CORE_END_FLAG];
    return !!(flag && flag.pos && flag.pos.roomName === room.name);
}

function shouldActivate(room, roomMemo) {
    if (!room || !room.controller || !room.controller.my) return false;
    const spawns = roomMemo && Array.isArray(roomMemo.mySpawns) ? roomMemo.mySpawns : room.find(FIND_MY_SPAWNS);
    if (!spawns || spawns.length <= 0) return false;
    if (hasCoreLaneFlag(room)) return false;
    return true;
}

function getSimpleCoreTargets(room, roomMemo) {
    if (!room) return [];
    const myStructures = roomMemo && Array.isArray(roomMemo.myStructures) ? roomMemo.myStructures : room.find(FIND_MY_STRUCTURES);
    const out = [];
    for (let i = 0; i < myStructures.length; i++) {
        const s = myStructures[i];
        if (!s || !s.store || typeof s.store.getFreeCapacity !== 'function') continue;
        if (!SIMPLE_CORE_TARGET_TYPES.has(s.structureType)) continue;
        const free = s.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
        if (s.structureType === STRUCTURE_TOWER && free < TOWER_REFILL_MIN_FREE) continue;
        if (s.structureType !== STRUCTURE_TOWER && free <= 0) continue;
        out.push(s);
    }
    return out;
}

function sumEnergyNeed(structures) {
    if (!Array.isArray(structures) || structures.length <= 0) return 0;
    let needed = 0;
    for (let i = 0; i < structures.length; i++) {
        const target = structures[i];
        if (!target || !target.store) continue;
        needed += target.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
    }
    return needed;
}

function estimateDesiredCount(totalNeed) {
    if (!Number.isFinite(totalNeed) || totalNeed <= 0) return 0;
    return Math.max(1, Math.min(MAX_SIMPLE_HAULERS, Math.ceil(totalNeed / 300)));
}

function estimateRequiredCarry(totalNeed, desiredCount) {
    if (!Number.isFinite(totalNeed) || totalNeed <= 0 || desiredCount <= 0) return 0;
    const perHaulerNeed = Math.ceil(totalNeed / Math.max(1, desiredCount));
    return Math.max(2, Math.min(20, Math.ceil(perHaulerNeed / 100)));
}

function getSourceIds(room, intel, refillIds, roomMemo) {
    if (!room) return [];
    const excluded = new Set([].concat(refillIds || []));
    const ids = [];
    const seen = Object.create(null);

    function addId(id) {
        if (!id || excluded.has(id) || seen[id]) return;
        seen[id] = true;
        ids.push(id);
    }

    if (intel && Array.isArray(intel.allEnergySources)) {
        for (let i = 0; i < intel.allEnergySources.length; i++) {
            const src = intel.allEnergySources[i];
            if (!src || !src.id) continue;
            addId(src.id);
        }
    }

    const droppedAll = roomMemo && Array.isArray(roomMemo.dropped) ? roomMemo.dropped : room.find(FIND_DROPPED_RESOURCES);
    const dropped = droppedAll.filter(r => r && r.resourceType === RESOURCE_ENERGY && r.amount > 0);
    for (let i = 0; i < dropped.length; i++) addId(dropped[i].id);

    const tombstonesAll = roomMemo && Array.isArray(roomMemo.tombstones) ? roomMemo.tombstones : room.find(FIND_TOMBSTONES);
    const tombstones = tombstonesAll.filter(t => t && t.store && (t.store[RESOURCE_ENERGY] || 0) > 0);
    for (let i = 0; i < tombstones.length; i++) addId(tombstones[i].id);

    const ruinsAll = roomMemo && Array.isArray(roomMemo.ruins) ? roomMemo.ruins : room.find(FIND_RUINS);
    const ruins = ruinsAll.filter(r => r && r.store && (r.store[RESOURCE_ENERGY] || 0) > 0);
    for (let i = 0; i < ruins.length; i++) addId(ruins[i].id);

    const linksAll = roomMemo && Array.isArray(roomMemo.myLinks) ? roomMemo.myLinks : room.find(FIND_MY_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_LINK
    });
    const links = linksAll.filter(s => s && s.store && (s.store[RESOURCE_ENERGY] || 0) > 0);
    for (let i = 0; i < links.length; i++) addId(links[i].id);

    return ids;
}

function estimateSourceSupply(room, sourceIds, roomMemo, objectCache) {
    if (!room || !Array.isArray(sourceIds) || sourceIds.length <= 0) return 0;
    let total = 0;
    const cap = 3000;
    for (let i = 0; i < sourceIds.length; i++) {
        const src = getObjectByIdCached(sourceIds[i], objectCache, roomMemo);
        if (!src) continue;
        if (src.store) total += src.store[RESOURCE_ENERGY] || 0;
        else if (src.resourceType === RESOURCE_ENERGY && Number.isFinite(src.amount)) total += src.amount;
        if (total >= cap) return cap;
    }
    return total;
}

function getObservedAssignedSimpleHaulers(mission, roomName) {
    const assigned = [];
    const missionName = mission && mission.meta ? mission.meta.missionName : null;
    for (const name in Game.creeps) {
        const creep = Game.creeps[name];
        if (!creep || !creep.my || !creep.memory) continue;
        if (creep.memory.role !== 'simpleHaulerCore') continue;
        if (roomName && creep.memory.room && creep.memory.room !== roomName) continue;
        if (missionName && creep.memory.missionName !== missionName) continue;
        assigned.push(creep.name);
    }
    return assigned;
}

function getSimpleCorePlanStore() {
    return heap.getStore(SIMPLE_CORE_PLAN_STORE, { ttl: SIMPLE_CORE_PLAN_CACHE_TTL });
}

function getSimpleCorePlanSignature(roomName, intel, roomMemo) {
    const sourceCount = intel && Array.isArray(intel.allEnergySources) ? intel.allEnergySources.length : 0;
    const myStructureCount = roomMemo && Array.isArray(roomMemo.myStructures) ? roomMemo.myStructures.length : 0;
    const droppedCount = roomMemo && Array.isArray(roomMemo.dropped) ? roomMemo.dropped.length : 0;
    const tombstoneCount = roomMemo && Array.isArray(roomMemo.tombstones) ? roomMemo.tombstones.length : 0;
    const ruinCount = roomMemo && Array.isArray(roomMemo.ruins) ? roomMemo.ruins.length : 0;
    const linkCount = roomMemo && Array.isArray(roomMemo.myLinks) ? roomMemo.myLinks.length : 0;
    return [
        roomName || '-',
        sourceCount,
        myStructureCount,
        droppedCount,
        tombstoneCount,
        ruinCount,
        linkCount
    ].join(':');
}

function getCachedSimpleCorePlan(roomName, signature) {
    if (!roomName || !signature) return null;
    const store = getSimpleCorePlanStore();
    const key = `${roomName}:${signature}`;
    const cached = store[key];
    if (!cached || !Number.isFinite(cached.tick)) return null;
    if ((Game.time - cached.tick) > SIMPLE_CORE_PLAN_REPLAN_INTERVAL) return null;
    return cached;
}

function setCachedSimpleCorePlan(roomName, signature, plan) {
    if (!roomName || !signature) return;
    const store = getSimpleCorePlanStore();
    const key = `${roomName}:${signature}`;
    store[key] = Object.assign({ tick: Game.time }, plan);
}

function shouldReplanSimpleCoreMission(mission, signature) {
    const meta = mission && mission.meta ? mission.meta : {};
    const data = mission && mission.data ? mission.data : {};
    if (!meta || meta.planSignature !== signature) return true;
    if (!Number.isFinite(meta.planTick)) return true;
    if ((Game.time - meta.planTick) >= SIMPLE_CORE_PLAN_REPLAN_INTERVAL) return true;
    if (!Array.isArray(data.refillTargetIds) || !Array.isArray(data.sourceIds)) return true;
    return false;
}

function getActiveRefillTargetsByIds(refillIds, roomMemo, objectCache) {
    const targets = [];
    const activeIds = [];
    if (!Array.isArray(refillIds) || refillIds.length <= 0) {
        return { targets, activeIds };
    }
    for (let i = 0; i < refillIds.length; i++) {
        const target = getObjectByIdCached(refillIds[i], objectCache, roomMemo);
        if (!target || !target.store || typeof target.store.getFreeCapacity !== 'function') continue;
        if (!SIMPLE_CORE_TARGET_TYPES.has(target.structureType)) continue;
        const free = target.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
        if (target.structureType === STRUCTURE_TOWER && free < TOWER_REFILL_MIN_FREE) continue;
        if (target.structureType !== STRUCTURE_TOWER && free <= 0) continue;
        activeIds.push(target.id);
        targets.push(target);
    }
    return { targets, activeIds };
}

function getActiveSourceIds(sourceIds, roomMemo, objectCache) {
    const activeIds = [];
    if (!Array.isArray(sourceIds) || sourceIds.length <= 0) return activeIds;
    for (let i = 0; i < sourceIds.length; i++) {
        const source = getObjectByIdCached(sourceIds[i], objectCache, roomMemo);
        if (!source) continue;
        if (source.store && (source.store[RESOURCE_ENERGY] || 0) > 0) {
            activeIds.push(source.id);
            continue;
        }
        if (source.resourceType === RESOURCE_ENERGY && Number.isFinite(source.amount) && source.amount > 0) {
            activeIds.push(source.id);
        }
    }
    return activeIds;
}

module.exports = {
    makeKey(context) {
        return missionKeys.makeUserMissionKey(
            context.targetRoom || context.sponsorRoom,
            'logisticsSimpleCore',
            'simpleCore'
        );
    },

    reconcileRoom({ room, intel, context, missionBoard }) {
        if (!room || !missionBoard) return;
        if (!missionThrottle.shouldRunReconcile('logisticsSimpleCore', room.name, Game.time)) return;
        const roomMemo = getSimpleCoreRoomMemo(room, getRoomCache(room));
        if (!shouldActivate(room, roomMemo)) return;

        missionBoard.createMission('logisticsSimpleCore', {
            sponsorRoom: room.name,
            targetRoom: room.name,
            priority: context && context.opState === 'EMERGENCY' ? 1000 : 100
        }, { room, intel, context });
    },

    create(context) {
        const now = Game.time;
        const key = this.makeKey(context);
        return {
            id: key,
            key,
            type: 'logisticsSimpleCore',
            class: missionClasses.SERVICE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.targetRoom || context.sponsorRoom,
            priority: Number.isFinite(context.priority) ? context.priority : 100,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: null,
            assigned: { primary: [], support: [] },
            demand: { role: 'simpleHaulerCore', count: 1, bodyProfile: 'hauler' },
            goal: {
                kind: 'service',
                target: { kind: 'simple_core_refill', roomName: context.targetRoom || context.sponsorRoom },
                success: { kind: 'refill_active' },
                completion: 'never'
            },
            progress: {
                stage: 'simple_core_refill',
                goalState: 'seeking_assignment',
                assignedPrimary: 0
            },
            meta: {
                missionName: `logistics:simpleCore:${context.targetRoom || context.sponsorRoom}`,
                desiredCount: 0
            },
            data: {
                refillTargetIds: [],
                sourceIds: []
            },
            statusReason: null
        };
    },

    validate(mission, runtimeCtx) {
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        const roomMemo = getSimpleCoreRoomMemo(room, getRoomCache(room));
        return shouldActivate(room, roomMemo);
    },

    refresh(mission, runtimeCtx) {
        cleanupAssigned(mission);

        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        const roomMemo = getSimpleCoreRoomMemo(room, getRoomCache(room));
        if (!shouldActivate(room, roomMemo)) return;
        const objectCache = Object.create(null);
        const intel = runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null;
        const planSignature = getSimpleCorePlanSignature(roomName, intel, roomMemo);
        const shouldReplan = shouldReplanSimpleCoreMission(mission, planSignature);

        let planState = 'cached';
        let refillIds = mission && mission.data && Array.isArray(mission.data.refillTargetIds)
            ? mission.data.refillTargetIds
            : [];
        let sourceIds = mission && mission.data && Array.isArray(mission.data.sourceIds)
            ? mission.data.sourceIds
            : [];

        if (shouldReplan) {
            const cachedPlan = getCachedSimpleCorePlan(roomName, planSignature);
            if (cachedPlan && Array.isArray(cachedPlan.refillIds) && Array.isArray(cachedPlan.sourceIds)) {
                refillIds = cachedPlan.refillIds.slice();
                sourceIds = cachedPlan.sourceIds.slice();
                planState = 'cache_hit';
            } else {
                const nextTargets = getSimpleCoreTargets(room, roomMemo);
                const nextRefillIds = nextTargets.map(t => t.id);
                refillIds = nextRefillIds;
                sourceIds = getSourceIds(room, intel, nextRefillIds, roomMemo);
                setCachedSimpleCorePlan(roomName, planSignature, { refillIds, sourceIds });
                planState = 'replanned';
            }
        }

        const activeRefill = getActiveRefillTargetsByIds(refillIds, roomMemo, objectCache);
        const activeSourceIds = getActiveSourceIds(sourceIds, roomMemo, objectCache);
        const refillTargets = activeRefill.targets;
        const activeRefillIds = activeRefill.activeIds;
        const refillNeed = sumEnergyNeed(refillTargets);
        const totalNeed = refillNeed;
        const sourceSupply = estimateSourceSupply(room, activeSourceIds, roomMemo, objectCache);
        const observedAssigned = getObservedAssignedSimpleHaulers(mission, roomName);

        let desiredCount = Math.max(MIN_SIMPLE_CORE_HAULERS, estimateDesiredCount(totalNeed));
        if (sourceSupply <= 0) desiredCount = MIN_SIMPLE_CORE_HAULERS;
        const requiredCarry = estimateRequiredCarry(totalNeed, desiredCount);

        setIfChanged(mission, 'targetId', activeRefillIds.length > 0 ? activeRefillIds[0] : null);
        mission.meta = mission.meta || {};
        setIfChanged(mission.meta, 'desiredCount', desiredCount);
        setIfChanged(mission.meta, 'requiredCarry', requiredCarry);
        setIfChanged(mission.meta, 'planSignature', planSignature);
        if (planState !== 'cached') setIfChanged(mission.meta, 'planTick', Game.time);
        if (!mission.meta.missionName) {
            setIfChanged(mission.meta, 'missionName', `logistics:simpleCore:${roomName}`);
        }
        const nextRequirements = {
            archetype: 'simpleHaulerCore',
            minCount: desiredCount,
            maxCount: desiredCount,
            requiredCarry,
            spawn: true,
            spawnFromFleet: false
        };
        setObjectIfChanged(mission, 'requirements', nextRequirements);

        const nextDemand = {
            role: 'simpleHaulerCore',
            count: Math.max(0, desiredCount - mission.assigned.primary.length),
            bodyProfile: 'hauler'
        };
        setObjectIfChanged(mission, 'demand', nextDemand);

        mission.data = mission.data || {};
        setArrayIfChanged(mission.data, 'refillTargetIds', activeRefillIds);
        setArrayIfChanged(mission.data, 'sourceIds', activeSourceIds);

        mission.progress = mission.progress || {};
        setIfChanged(mission.progress, 'stage', 'simple_core_refill');
        setIfChanged(mission.progress, 'goalState', mission.assigned.primary.length > 0 ? 'sustaining' : 'seeking_assignment');
        setIfChanged(mission.progress, 'assignedPrimary', mission.assigned.primary.length);
        setIfChanged(mission.progress, 'refillTargetCount', activeRefillIds.length);
        setIfChanged(mission.progress, 'sourceCount', activeSourceIds.length);
        setIfChanged(mission.progress, 'sourceSupply', sourceSupply);
        setIfChanged(mission.progress, 'refillNeed', refillNeed);
        setIfChanged(mission.progress, 'totalNeed', totalNeed);
        setIfChanged(mission.progress, 'requiredCarry', requiredCarry);
        setIfChanged(mission.progress, 'planState', planState);
        setIfChanged(mission.progress, 'observedAssigned', observedAssigned.length);
        setArrayIfChanged(mission.progress, 'assignedNames', mission.assigned.primary);
        setArrayIfChanged(mission.progress, 'observedNames', observedAssigned);
        if (mission.assigned.primary.length > 0) setIfChanged(mission, 'lastProgressTick', Game.time);

        if (mission.assigned.primary.length !== observedAssigned.length) {
            logSimpleCoreDebug(
                `[SimpleCore] ${roomName} assignedMismatch missionAssigned=${mission.assigned.primary.length} ` +
                `observed=${observedAssigned.length} missionNames=${mission.assigned.primary.join(',') || '-'} ` +
                `observedNames=${observedAssigned.join(',') || '-'}`
            );
        }
        logSimpleCoreDebug(
            `[SimpleCore] ${roomName} desired=${desiredCount} assigned=${mission.assigned.primary.length} ` +
            `observed=${observedAssigned.length} refillTargets=${activeRefillIds.length} ` +
            `sources=${activeSourceIds.length} sourceSupply=${sourceSupply} totalNeed=${totalNeed} ` +
            `demand=${mission.demand.count} requiredCarry=${requiredCarry} planState=${planState}`
        );
    },

    isComplete() {
        return false;
    },

    toContractMission(mission) {
        return {
            name: mission && mission.meta && mission.meta.missionName
                ? mission.meta.missionName
                : `logistics:simpleCore:${(mission && (mission.targetRoom || mission.sponsorRoom)) || 'room'}`,
            type: 'simple_haul',
            archetype: 'simpleHaulerCore',
            targetId: mission && mission.targetId ? mission.targetId : null,
            data: mission && mission.data ? mission.data : {},
            requirements: mission && mission.requirements ? mission.requirements : {
                archetype: 'simpleHaulerCore',
                minCount: 0,
                maxCount: 0,
                requiredCarry: 0,
                spawn: true,
                spawnFromFleet: false
            },
            priority: mission && Number.isFinite(mission.priority) ? mission.priority : 100
        };
    }
};

