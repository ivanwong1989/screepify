const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');

const policyConstants = require('managers_overseer_policy_room.policy.constants');

function cleanupAssigned(mission) {
    if (!mission.assigned) mission.assigned = { primary: [], support: [] };
    if (!Array.isArray(mission.assigned.primary)) mission.assigned.primary = [];
    mission.assigned.primary = mission.assigned.primary.filter(name => !!Game.creeps[name]);
}

function getMineralInfo(intel, id) {
    if (!intel || !id) return null;
    if (intel._mineralByIdTick !== Game.time || !intel._mineralById) {
        const byId = Object.create(null);
        const minerals = Array.isArray(intel.minerals) ? intel.minerals : [];
        for (let i = 0; i < minerals.length; i++) {
            const mineral = minerals[i];
            if (!mineral || !mineral.id) continue;
            byId[mineral.id] = mineral;
        }
        intel._mineralById = byId;
        intel._mineralByIdTick = Game.time;
    }
    return intel._mineralById[id] || null;
}

module.exports = {
    makeKey(context) {
        return missionKeys.makeMineralKey(context.sponsorRoom, context.mineralId);
    },

    discover({ room, intel, context }) {
        if (!room || !intel) return [];
        const policy = context && context.policy ? context.policy : null;
        const phase = policy && policy.phase ? policy.phase : policyConstants.PHASE.BOOTSTRAP;
        const state = policy && policy.state ? policy.state : policyConstants.STATE.RECOVER;
        const phaseRank = policyConstants.PHASE_RANK[phase] || 0;
        if (phaseRank < policyConstants.PHASE_RANK[policyConstants.PHASE.LABS]) return [];
        if (
            state === policyConstants.STATE.CRITICAL
            || state === policyConstants.STATE.RECOVER
            || state === policyConstants.STATE.SIEGE
        ) return [];

        const minerals = Array.isArray(intel.minerals) ? intel.minerals : [];
        const out = [];
        for (let i = 0; i < minerals.length; i++) {
            const mineral = minerals[i];
            if (!mineral || !mineral.id) continue;
            if (!mineral.hasExtractor) continue;
            if (mineral.mineralAmount <= 0) continue;
            if (mineral.ticksToRegeneration && mineral.ticksToRegeneration > 0) continue;
            if ((mineral.availableSpaces || 0) <= 0) continue;

            const createContext = {
                sponsorRoom: room.name,
                mineralId: mineral.id,
                priority: 40
            };
            out.push({
                key: this.makeKey(createContext),
                createContext,
                discoveredMeta: {
                    mineralId: mineral.id
                }
            });
        }
        return out;
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
        const depleted = !mineral || mineral.mineralAmount <= 0 || (mineral.ticksToRegeneration && mineral.ticksToRegeneration > 0);
        const spawnSlot = `mineral:${mission.sponsorRoom}:${mission.targetId}:0`;
        const assignedCount = mission.assigned.primary.length;

        mission.meta = mission.meta || {};
        mission.meta.missionName = mission.meta.missionName || `mineral:${mission.targetId}`;
        mission.meta.depleted = depleted;

        mission.mineralId = mission.targetId;
        mission.requirements = mission.requirements || {};
        mission.requirements.archetype = 'mineral_miner';
        mission.requirements.minCount = 1;
        mission.requirements.maxCount = 1;

        if (!Array.isArray(mission.spawnSlots) || mission.spawnSlots.length !== 1 || mission.spawnSlots[0] !== spawnSlot) {
            mission.spawnSlots = [spawnSlot];
        }

        mission.data = mission.data || {};
        mission.data.containerId = mineral && mineral.containerId ? mineral.containerId : null;
        mission.data.extractorId = mineral && mineral.extractorId ? mineral.extractorId : null;
        mission.data.resourceType = mineral && mineral.mineralType ? mineral.mineralType : null;

        mission.demand = mission.demand || {};
        mission.demand.role = 'mineral_miner';
        mission.demand.count = depleted ? 0 : Math.max(0, 1 - assignedCount);
        mission.demand.bodyProfile = 'mineral_miner';

        if (assignedCount > 0 && !depleted) mission.lastProgressTick = Game.time;
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


