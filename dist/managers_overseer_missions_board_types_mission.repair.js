const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const overseerOpportunisticRepair = require('managers_overseer_intel_overseer.opportunistic.repair');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');

const CRITICAL_WALL_HITS = 5000;
const REPAIR_MIN_RATIO = 0.9;
const DEFAULT_FORTIFY_TARGET = 500000;
const FORTIFY_TARGET_CAP = 3;

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
        const targetHits = Number.isFinite(fortifyPolicy && fortifyPolicy.target) ? fortifyPolicy.target : null;
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
                targetHits: Number.isFinite(context.targetHits) ? context.targetHits : null
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

        if (structure) {
            const prev = Number.isFinite(mission.progress.lastHits) ? mission.progress.lastHits : structure.hits;
            if (structure.hits > prev) mission.lastProgressTick = Game.time;
            mission.progress.lastHits = structure.hits;
            mission.progress.hitsMax = structure.hitsMax || 0;
            mission.meta.structureType = structure.structureType;
            if (fortify) {
                const policyTarget = room && room.memory && room.memory.overseer && room.memory.overseer.fortifyPolicy
                    ? room.memory.overseer.fortifyPolicy.target
                    : null;
                mission.meta.targetHits = Number.isFinite(policyTarget) ? policyTarget : (mission.meta.targetHits || DEFAULT_FORTIFY_TARGET);
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
            count: Math.max(0, 1 - mission.assigned.primary.length),
            bodyProfile: 'worker'
        };
        mission.data = {
            sourceIds: intel && Array.isArray(intel.allEnergySources) ? intel.allEnergySources.map(s => s.id) : [],
            allowPartial: true,
            fortify
        };
    },

    isComplete(mission, runtimeCtx) {
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        const structure = Game.getObjectById(mission.targetId);
        if (!structure) return !!room;

        const fortify = !!(mission.meta && mission.meta.fortify);
        const targetHits = Number.isFinite(mission.meta && mission.meta.targetHits)
            ? mission.meta.targetHits
            : (fortify ? DEFAULT_FORTIFY_TARGET : getRepairThreshold(structure));
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
                fortify,
                allowPartial: true
            },
            requirements: {
                archetype: 'worker',
                requiredWork: 1,
                minCount: 1,
                maxCount: 1,
                spawnFromFleet: true,
                spawn: spawnAllowed
            },
            priority: mission.priority || (fortify ? 55 : 65)
        };
    }
};


