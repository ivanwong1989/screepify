const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const overseerOpportunisticRepair = require('managers_overseer_intel_overseer.opportunistic.repair');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');

const CRITICAL_WALL_HITS = 5000;
const REPAIR_MIN_RATIO = 0.9;
const DEFAULT_FORTIFY_TARGET = 500000;
const FORTIFY_TARGET_CAP = 3;
const FORTIFY_SETTINGS = {
    0: { start: 0, target: 0 },
    1: { start: 0, target: 0 },
    2: { start: 10000, target: 20000 },
    3: { start: 20000, target: 150000 },
    4: { start: 150000, target: 300000 },
    5: { start: 300000, target: 500000 },
    6: { start: 900000, target: 1300000 },
    7: { start: 3000000, target: 3500000 },
    8: { start: 3500000, target: 5000000 }
};
const REPAIR_WORKER_TUNING = Object.freeze({
    desiredWorkRepair: 1,
    desiredWorkFortify: 1,
    minCountRepair: 1,
    maxCountRepair: 1,
    minCountFortify: 1,
    maxCountFortify: 1
});

function getDesiredRepairWork(fortify) {
    return fortify ? REPAIR_WORKER_TUNING.desiredWorkFortify : REPAIR_WORKER_TUNING.desiredWorkRepair;
}

function getRepairMinCount(fortify) {
    return fortify ? REPAIR_WORKER_TUNING.minCountFortify : REPAIR_WORKER_TUNING.minCountRepair;
}

function getRepairMaxCount(fortify) {
    return fortify ? REPAIR_WORKER_TUNING.maxCountFortify : REPAIR_WORKER_TUNING.maxCountRepair;
}

function cleanupAssigned(mission) {
    if (!mission.assigned) mission.assigned = { primary: [], support: [] };
    if (!Array.isArray(mission.assigned.primary)) mission.assigned.primary = [];
    mission.assigned.primary = mission.assigned.primary.filter(name => !!Game.creeps[name]);
}

function isFortifyTarget(structure) {
    if (!structure) return false;
    return structure.structureType === STRUCTURE_WALL || structure.structureType === STRUCTURE_RAMPART;
}

function getRepairThreshold(structure) {
    if (!structure || !structure.hitsMax) return 0;
    if (isFortifyTarget(structure)) return structure.hitsMax;
    return Math.floor(structure.hitsMax * REPAIR_MIN_RATIO);
}

function getFortifyPolicyTarget(room) {
    const policyTarget = room && room.memory && room.memory.overseer && room.memory.overseer.fortifyPolicy
        ? room.memory.overseer.fortifyPolicy.target
        : null;
    if (Number.isFinite(policyTarget)) return policyTarget;
    const rcl = room && room.controller ? room.controller.level : 0;
    const defaults = FORTIFY_SETTINGS[rcl] || FORTIFY_SETTINGS[0];
    if (Number.isFinite(defaults && defaults.target)) return defaults.target;
    return DEFAULT_FORTIFY_TARGET;
}

function getMissionFortifyTargetHits(room, structure, existingTarget) {
    const base = getFortifyPolicyTarget(room);
    const target = Number.isFinite(base) ? base : existingTarget;
    if (!Number.isFinite(target) || target <= 0) return 0;
    if (structure && Number.isFinite(structure.hitsMax) && structure.hitsMax > 0) {
        return Math.min(target, structure.hitsMax);
    }
    return target;
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

function getNonMiningContainerIds(room, intel) {
    if (!room) return [];
    const miningContainerIds = getMiningContainerIdSet(intel);
    const containers = (intel && intel.structures && intel.structures[STRUCTURE_CONTAINER])
        ? intel.structures[STRUCTURE_CONTAINER]
        : room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER });

    const ids = [];
    for (let i = 0; i < containers.length; i++) {
        const c = containers[i];
        if (!c || !c.id || miningContainerIds.has(c.id)) continue;
        ids.push(c.id);
    }
    return ids;
}

module.exports = {
    makeKey(context) {
        return missionKeys.makeRepairTargetKey(
            context.targetRoom || context.sponsorRoom,
            context.targetId,
            context.fortify ? 'fortify' : 'repair'
        );
    },

    reconcileRoom({ room, intel, context, missionBoard }) {
        if (!room || !missionBoard) return;
        if (context && context.opState === 'EMERGENCY') return;
        if (!missionThrottle.shouldRunReconcile('repair', room.name, Game.time)) return;

        const scan = overseerOpportunisticRepair.getRoomScan(room.name);
        if (!scan) return;

        const repairIds = Array.isArray(scan.repairIds) ? scan.repairIds : [];
        for (let i = 0; i < repairIds.length; i++) {
            const id = repairIds[i];
            missionBoard.createMission('repair', {
                sponsorRoom: room.name,
                targetRoom: room.name,
                targetId: id,
                fortify: false,
                priority: 65
            }, { room, intel, context });
        }

        const fortifyPolicy = room.memory && room.memory.overseer && room.memory.overseer.fortifyPolicy
            ? room.memory.overseer.fortifyPolicy
            : null;
        const targetHits = Number.isFinite(fortifyPolicy && fortifyPolicy.target)
            ? fortifyPolicy.target
            : getFortifyPolicyTarget(room);
        const economyState = context && context.economyState ? context.economyState : 'STOCKPILING';
        const allowFortifySpawn = economyState === 'UPGRADING' || !!scan.critical;

        const fortifyIds = Array.isArray(scan.fortifyIds) ? scan.fortifyIds : [];
        const cap = Math.max(1, FORTIFY_TARGET_CAP);
        for (let i = 0; i < Math.min(cap, fortifyIds.length); i++) {
            const id = fortifyIds[i];
            missionBoard.createMission('repair', {
                sponsorRoom: room.name,
                targetRoom: room.name,
                targetId: id,
                fortify: true,
                targetHits,
                spawnAllowed: allowFortifySpawn,
                priority: allowFortifySpawn ? 55 : 35
            }, { room, intel, context });
        }
    },

    create(context) {
        const now = Game.time;
        const fortify = !!context.fortify;
        return {
            id: this.makeKey(context),
            key: this.makeKey(context),
            type: 'repair',
            class: missionClasses.FINITE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.targetRoom || context.sponsorRoom,
            priority: Number.isFinite(context.priority) ? context.priority : (fortify ? 55 : 65),
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: context.targetId,
            assigned: { primary: [], support: [] },
            demand: { role: 'worker', count: 1, bodyProfile: 'worker' },
            progress: {
                stage: fortify ? 'fortify' : 'repair',
                lastHits: 0
            },
            meta: {
                missionName: `${fortify ? 'fortify' : 'repair'}:${context.targetId}`,
                fortify,
                spawnAllowed: context.spawnAllowed !== false,
                targetHits: Number.isFinite(context.targetHits) ? context.targetHits : null,
                desiredWork: Number.isFinite(context.requiredWork) ? context.requiredWork : getDesiredRepairWork(fortify),
                minCount: getRepairMinCount(fortify),
                maxCount: getRepairMaxCount(fortify)
            },
            statusReason: null
        };
    },

    validate(mission, runtimeCtx) {
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        if (!room) return true;
        const structure = Game.getObjectById(mission.targetId);
        return !!structure;
    },

    refresh(mission, runtimeCtx) {
        cleanupAssigned(mission);
        const intel = runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null;
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        const structure = Game.getObjectById(mission.targetId);
        const fortify = !!(mission.meta && mission.meta.fortify);

        mission.progress = mission.progress || {};
        mission.meta = mission.meta || {};
        mission.meta.missionName = mission.meta.missionName || `${fortify ? 'fortify' : 'repair'}:${mission.targetId}`;
        mission.meta.desiredWork = getDesiredRepairWork(fortify);
        mission.meta.minCount = getRepairMinCount(fortify);
        mission.meta.maxCount = getRepairMaxCount(fortify);

        if (structure) {
            const prev = Number.isFinite(mission.progress.lastHits) ? mission.progress.lastHits : structure.hits;
            if (structure.hits > prev) mission.lastProgressTick = Game.time;
            mission.progress.lastHits = structure.hits;
            mission.progress.hitsMax = structure.hitsMax || 0;
            mission.meta.structureType = structure.structureType;
            if (fortify) {
                mission.meta.targetHits = getMissionFortifyTargetHits(room, structure, mission.meta.targetHits || DEFAULT_FORTIFY_TARGET);
            } else {
                mission.meta.targetHits = getRepairThreshold(structure);
            }

            if (!fortify) {
                const critical = (isFortifyTarget(structure) && structure.hits < CRITICAL_WALL_HITS) ||
                    (!isFortifyTarget(structure) && structure.hitsMax > 0 && (structure.hits / structure.hitsMax) < 0.7);
                mission.priority = critical ? 85 : 65;
            }
        }

        mission.demand = {
            role: 'worker',
            count: Math.max(0, mission.meta.minCount - mission.assigned.primary.length),
            bodyProfile: 'worker'
        };
        mission.data = {
            sourceIds: intel && Array.isArray(intel.allEnergySources) ? intel.allEnergySources.map(s => s.id) : [],
            nonMiningContainerIds: getNonMiningContainerIds(room, intel),
            allowPartial: true,
            fortify,
            targetHits: Number.isFinite(mission.meta.targetHits) ? mission.meta.targetHits : null
        };
    },

    isComplete(mission, runtimeCtx) {
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        const structure = Game.getObjectById(mission.targetId);
        if (!structure) return !!room;

        const fortify = !!(mission.meta && mission.meta.fortify);
        const targetHits = fortify
            ? getMissionFortifyTargetHits(room, structure, mission.meta && mission.meta.targetHits)
            : getRepairThreshold(structure);
        return structure.hits >= targetHits;
    },

    toContractMission(mission) {
        const fortify = !!(mission.meta && mission.meta.fortify);
        const spawnAllowed = mission.meta && mission.meta.spawnAllowed !== false;
        return {
            name: mission.meta && mission.meta.missionName ? mission.meta.missionName : `${fortify ? 'fortify' : 'repair'}:${mission.targetId}`,
            type: 'repair',
            archetype: 'worker',
            targetId: mission.targetId,
            data: {
                sourceIds: mission.data && Array.isArray(mission.data.sourceIds) ? mission.data.sourceIds : [],
                nonMiningContainerIds: mission.data && Array.isArray(mission.data.nonMiningContainerIds)
                    ? mission.data.nonMiningContainerIds
                    : [],
                fortify,
                allowPartial: true,
                targetHits: mission.data && Number.isFinite(mission.data.targetHits) ? mission.data.targetHits : null
            },
            requirements: {
                archetype: 'worker',
                requiredWork: mission.meta && Number.isFinite(mission.meta.desiredWork) ? mission.meta.desiredWork : getDesiredRepairWork(fortify),
                minCount: mission.meta && Number.isFinite(mission.meta.minCount) ? mission.meta.minCount : getRepairMinCount(fortify),
                maxCount: mission.meta && Number.isFinite(mission.meta.maxCount) ? mission.meta.maxCount : getRepairMaxCount(fortify),
                spawnFromFleet: true,
                spawn: spawnAllowed
            },
            priority: mission.priority || (fortify ? 55 : 65)
        };
    }
};


