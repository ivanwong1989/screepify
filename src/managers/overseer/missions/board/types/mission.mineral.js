const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');

function cleanupAssigned(mission) {
    if (!mission.assigned) mission.assigned = { primary: [], support: [] };
    if (!Array.isArray(mission.assigned.primary)) mission.assigned.primary = [];
    mission.assigned.primary = mission.assigned.primary.filter(name => !!Game.creeps[name]);
}

function getMineralInfo(intel, id) {
    const minerals = intel && Array.isArray(intel.minerals) ? intel.minerals : [];
    for (let i = 0; i < minerals.length; i++) {
        const m = minerals[i];
        if (m && m.id === id) return m;
    }
    return null;
}

module.exports = {
    makeKey(context) {
        return missionKeys.makeMineralKey(context.sponsorRoom, context.mineralId);
    },

    reconcileRoom({ room, intel, context, missionBoard }) {
        if (!room || !intel || !missionBoard) return;
        if (context && context.opState === 'EMERGENCY') return;
        if (!missionThrottle.shouldRunReconcile('mineral', room.name, Game.time)) return;

        const minerals = Array.isArray(intel.minerals) ? intel.minerals : [];
        for (let i = 0; i < minerals.length; i++) {
            const mineral = minerals[i];
            if (!mineral || !mineral.id) continue;
            if (!mineral.hasExtractor) continue;
            if (mineral.mineralAmount <= 0) continue;
            if (mineral.ticksToRegeneration && mineral.ticksToRegeneration > 0) continue;
            if ((mineral.availableSpaces || 0) <= 0) continue;

            missionBoard.createMission('mineral', {
                sponsorRoom: room.name,
                mineralId: mineral.id,
                priority: 40
            }, { room, intel, context });
        }
    },

    create(context) {
        const now = Game.time;
        return {
            id: this.makeKey(context),
            key: this.makeKey(context),
            type: 'mineral',
            class: missionClasses.SERVICE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.sponsorRoom,
            priority: Number.isFinite(context.priority) ? context.priority : 40,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: context.mineralId,
            assigned: { primary: [], support: [] },
            demand: { role: 'mineral_miner', count: 1, bodyProfile: 'mineral_miner' },
            progress: { stage: 'mining' },
            meta: {
                missionName: `mineral:${context.mineralId}`
            },
            statusReason: null
        };
    },

    validate(mission, runtimeCtx) {
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[mission.sponsorRoom];
        return !!(room && room.controller && room.controller.my);
    },

    refresh(mission, runtimeCtx) {
        cleanupAssigned(mission);
        const intel = runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null;
        const mineral = getMineralInfo(intel, mission.targetId);

        mission.meta = mission.meta || {};
        mission.meta.missionName = mission.meta.missionName || `mineral:${mission.targetId}`;
        mission.meta.depleted = !mineral || mineral.mineralAmount <= 0 || (mineral.ticksToRegeneration && mineral.ticksToRegeneration > 0);

        mission.mineralId = mission.targetId;
        mission.requirements = {
            archetype: 'mineral_miner',
            minCount: 1,
            maxCount: 1
        };
        mission.spawnSlots = [`mineral:${mission.sponsorRoom}:${mission.targetId}:0`];
        mission.data = {
            containerId: mineral && mineral.containerId ? mineral.containerId : null,
            extractorId: mineral && mineral.extractorId ? mineral.extractorId : null,
            resourceType: mineral && mineral.mineralType ? mineral.mineralType : null
        };
        mission.demand = {
            role: 'mineral_miner',
            count: mission.meta.depleted ? 0 : Math.max(0, 1 - mission.assigned.primary.length),
            bodyProfile: 'mineral_miner'
        };
        if (mission.assigned.primary.length > 0 && !mission.meta.depleted) mission.lastProgressTick = Game.time;
    },

    isComplete(mission) {
        return !!(mission.meta && mission.meta.depleted);
    },

    toContractMission(mission) {
        return {
            name: mission.meta && mission.meta.missionName ? mission.meta.missionName : `mineral:${mission.targetId}`,
            type: 'mineral',
            archetype: 'mineral_miner',
            mineralId: mission.targetId,
            requirements: {
                archetype: 'mineral_miner',
                minCount: 1,
                maxCount: 1
            },
            spawnSlots: mission.spawnSlots || [`mineral:${mission.sponsorRoom}:${mission.targetId}:0`],
            data: mission.data || {},
            priority: Number.isFinite(mission.priority) ? mission.priority : 40
        };
    }
};


