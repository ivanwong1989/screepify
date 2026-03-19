const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');

const CORE_END_FLAG = 'CORE_END';
const SIMPLE_CORE_TARGET_TYPES = new Set([
    STRUCTURE_SPAWN,
    STRUCTURE_EXTENSION,
    STRUCTURE_TOWER
]);
const TOWER_REFILL_MIN_FREE = 100;
const MAX_SIMPLE_HAULERS = 2;

function logSimpleCoreDebug(message) {
    if (typeof debug !== 'function') return;
    debug('mission.logistics', message);
}

function cleanupAssigned(mission) {
    if (!mission.assigned) mission.assigned = { primary: [], support: [] };
    if (!Array.isArray(mission.assigned.primary)) mission.assigned.primary = [];
    const before = mission.assigned.primary.slice();
    mission.assigned.primary = mission.assigned.primary.filter(name => !!Game.creeps[name]);
    if (before.length !== mission.assigned.primary.length) {
        const removed = before.filter(name => mission.assigned.primary.indexOf(name) === -1);
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

function shouldActivate(room) {
    if (!room || !room.controller || !room.controller.my) return false;
    const spawns = room.find(FIND_MY_SPAWNS);
    if (!spawns || spawns.length <= 0) return false;
    if (hasCoreLaneFlag(room)) return false;
    return true;
}

function getSimpleCoreTargets(room) {
    if (!room) return [];
    return room.find(FIND_MY_STRUCTURES, {
        filter: s => {
            if (!s || !s.store || typeof s.store.getFreeCapacity !== 'function') return false;
            if (!SIMPLE_CORE_TARGET_TYPES.has(s.structureType)) return false;
            const free = s.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
            if (s.structureType === STRUCTURE_TOWER) return free >= TOWER_REFILL_MIN_FREE;
            return free > 0;
        }
    });
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

function getSourceIds(room, intel, refillIds) {
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

    const dropped = room.find(FIND_DROPPED_RESOURCES, {
        filter: r => r && r.resourceType === RESOURCE_ENERGY && r.amount > 0
    });
    for (let i = 0; i < dropped.length; i++) addId(dropped[i].id);

    const tombstones = room.find(FIND_TOMBSTONES, {
        filter: t => t && t.store && (t.store[RESOURCE_ENERGY] || 0) > 0
    });
    for (let i = 0; i < tombstones.length; i++) addId(tombstones[i].id);

    const ruins = room.find(FIND_RUINS, {
        filter: r => r && r.store && (r.store[RESOURCE_ENERGY] || 0) > 0
    });
    for (let i = 0; i < ruins.length; i++) addId(ruins[i].id);

    const links = room.find(FIND_MY_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_LINK && s.store && (s.store[RESOURCE_ENERGY] || 0) > 0
    });
    for (let i = 0; i < links.length; i++) addId(links[i].id);

    return ids;
}

function estimateSourceSupply(room, sourceIds) {
    if (!room || !Array.isArray(sourceIds) || sourceIds.length <= 0) return 0;
    let total = 0;
    const cap = 3000;
    for (let i = 0; i < sourceIds.length; i++) {
        const src = Game.getObjectById(sourceIds[i]);
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
        if (!shouldActivate(room)) return;

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
        return shouldActivate(room);
    },

    refresh(mission, runtimeCtx) {
        cleanupAssigned(mission);

        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        if (!shouldActivate(room)) return;
        const intel = runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null;
        const refillTargets = getSimpleCoreTargets(room);
        const refillIds = refillTargets.map(t => t.id);
        const sourceIds = getSourceIds(room, intel, refillIds);
        const refillNeed = sumEnergyNeed(refillTargets);
        const totalNeed = refillNeed;
        const sourceSupply = estimateSourceSupply(room, sourceIds);
        const observedAssigned = getObservedAssignedSimpleHaulers(mission, roomName);

        let desiredCount = estimateDesiredCount(totalNeed);
        if (desiredCount > 0 && sourceSupply <= 0) desiredCount = 0;
        const requiredCarry = estimateRequiredCarry(totalNeed, desiredCount);

        mission.targetId = refillIds.length > 0 ? refillIds[0] : null;
        mission.meta = mission.meta || {};
        mission.meta.desiredCount = desiredCount;
        mission.meta.requiredCarry = requiredCarry;
        if (!mission.meta.missionName) {
            mission.meta.missionName = `logistics:simpleCore:${roomName}`;
        }
        mission.requirements = {
            archetype: 'simpleHaulerCore',
            minCount: desiredCount,
            maxCount: desiredCount,
            requiredCarry,
            spawn: true,
            spawnFromFleet: false
        };
        mission.demand = {
            role: 'simpleHaulerCore',
            count: Math.max(0, desiredCount - mission.assigned.primary.length),
            bodyProfile: 'hauler'
        };
        mission.data = mission.data || {};
        mission.data.refillTargetIds = refillIds;
        mission.data.sourceIds = sourceIds;

        mission.progress = mission.progress || {};
        mission.progress.stage = 'simple_core_refill';
        mission.progress.goalState = mission.assigned.primary.length > 0 ? 'sustaining' : 'seeking_assignment';
        mission.progress.assignedPrimary = mission.assigned.primary.length;
        mission.progress.refillTargetCount = refillIds.length;
        mission.progress.sourceCount = sourceIds.length;
        mission.progress.sourceSupply = sourceSupply;
        mission.progress.refillNeed = refillNeed;
        mission.progress.totalNeed = totalNeed;
        mission.progress.requiredCarry = requiredCarry;
        mission.progress.observedAssigned = observedAssigned.length;
        mission.progress.assignedNames = mission.assigned.primary.slice();
        mission.progress.observedNames = observedAssigned.slice();
        if (mission.assigned.primary.length > 0) mission.lastProgressTick = Game.time;

        if (mission.assigned.primary.length !== observedAssigned.length) {
            logSimpleCoreDebug(
                `[SimpleCore] ${roomName} assignedMismatch missionAssigned=${mission.assigned.primary.length} ` +
                `observed=${observedAssigned.length} missionNames=${mission.assigned.primary.join(',') || '-'} ` +
                `observedNames=${observedAssigned.join(',') || '-'}`
            );
        }
        logSimpleCoreDebug(
            `[SimpleCore] ${roomName} desired=${desiredCount} assigned=${mission.assigned.primary.length} ` +
            `observed=${observedAssigned.length} refillTargets=${refillIds.length} ` +
            `sources=${sourceIds.length} sourceSupply=${sourceSupply} totalNeed=${totalNeed} ` +
            `demand=${mission.demand.count} requiredCarry=${requiredCarry}`
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

