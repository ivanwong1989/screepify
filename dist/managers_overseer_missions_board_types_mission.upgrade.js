const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');

const CRITICAL_DOWNGRADE_TICKS = 5000;
const DEFAULT_DESIRED_WORK = 15;
const STOCKPILING_DESIRED_WORK = 1;
const CONSTRUCTION_DESIRED_WORK = 1;
const MIN_COUNT_WITH_WORK = 1;
const LOW_RCL_LEVEL_THRESHOLD = 3;
const LOW_RCL_MAX_UPGRADER_COUNT = 4;

function cleanupAssigned(mission) {
    if (!mission.assigned) mission.assigned = { primary: [], support: [] };
    if (!Array.isArray(mission.assigned.primary)) mission.assigned.primary = [];
    mission.assigned.primary = mission.assigned.primary.filter(name => !!Game.creeps[name]);
}

function getMaxSpaces(intel) {
    const raw = intel && Number.isFinite(intel.availableControllerSpaces) ? intel.availableControllerSpaces : 1;
    return Math.min(12, Math.max(1, raw));
}

module.exports = {
    makeKey(context) {
        const roomName = context.targetRoom || context.sponsorRoom;
        return missionKeys.makeUpgradeKey(roomName, 'primary');
    },

    discover({ room, intel, context }) {
        if (!room) return [];
        if (!intel || !intel.controller || !intel.controller.my) return [];
        const policy = context && context.policy ? context.policy : null;
        const missionGates = policy && policy.missionGates ? policy.missionGates : null;
        if (missionGates && missionGates.upgrade === false) return [];
        const createContext = {
            sponsorRoom: room.name,
            targetRoom: room.name,
            controllerId: intel.controller.id,
            priority: 50
        };
        return [{
            key: this.makeKey(createContext),
            createContext,
            discoveredMeta: {
                controllerId: intel.controller.id
            }
        }];
    },

    create(context) {
        const now = Game.time;
        return {
            id: this.makeKey(context),
            key: this.makeKey(context),
            type: 'upgrade',
            class: missionClasses.SERVICE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.targetRoom || context.sponsorRoom,
            priority: Number.isFinite(context.priority) ? context.priority : 50,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: context.controllerId || null,
            assigned: { primary: [], support: [] },
            demand: { role: 'upgrader', count: 0, bodyProfile: 'upgrader' },
            progress: { stage: 'upgrading', lastProgress: 0 },
            meta: {
                missionName: 'upgrade:controller',
                spawnAllowed: true
            },
            statusReason: null
        };
    },

    validate(mission, runtimeCtx) {
        if (mission.meta && mission.meta.idle) return false;
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        if (!room) return true;
        return !!(room.controller && room.controller.my);
    },

    refresh(mission, runtimeCtx) {
        cleanupAssigned(mission);
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        const intel = runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null;
        const context = runtimeCtx && runtimeCtx.context ? runtimeCtx.context : {};
        const policy = context && context.policy ? context.policy : null;
        const controller = room && room.controller ? room.controller : null;

        if (controller) mission.targetId = controller.id;

        mission.data = {
            sourceIds: intel && Array.isArray(intel.allEnergySources) ? intel.allEnergySources.map(s => s.id) : []
        };

        const opState = context.opState || 'NORMAL';
        const economyState = context.economyState || (intel && intel.economyState) || 'STOCKPILING';
        const budget = Number.isFinite(context.budget) ? context.budget : ((room && room.energyCapacityAvailable) || 300);
        const assignedCount = mission.assigned.primary.length;
        const ticksToDowngrade = controller && Number.isFinite(controller.ticksToDowngrade) ? controller.ticksToDowngrade : 999999;
        const isCritical = ticksToDowngrade < CRITICAL_DOWNGRADE_TICKS;

        let upgradePriority = 50;
        let desiredWork = DEFAULT_DESIRED_WORK;
        if (controller && controller.level < LOW_RCL_LEVEL_THRESHOLD) desiredWork = DEFAULT_DESIRED_WORK;
        let spawnAllowed = true;

        if (economyState === 'STOCKPILING') {
            desiredWork = STOCKPILING_DESIRED_WORK;
            upgradePriority = 10;
            spawnAllowed = isCritical;
            if (isCritical) upgradePriority = 100;
        }

        if (intel && Array.isArray(intel.constructionSites) && intel.constructionSites.length > 0) {
            desiredWork = CONSTRUCTION_DESIRED_WORK;
            upgradePriority = 20;
        }

        let requiredWork = desiredWork;
        let minCount = desiredWork > 0 ? MIN_COUNT_WITH_WORK : 0;
        let maxCount = Math.max(1, Math.min(getMaxSpaces(intel), Number.isFinite(budget) ? getMaxSpaces(intel) : 1));
        if (controller && controller.level <= LOW_RCL_LEVEL_THRESHOLD) {
            maxCount = Math.min(maxCount, LOW_RCL_MAX_UPGRADER_COUNT);
        }
        if (economyState === 'STOCKPILING' && !isCritical) {
            requiredWork = 0;
            minCount = Math.min(assignedCount, maxCount);
            maxCount = minCount;
        }

        const upgradeIntensity = policy && policy.priorities
            ? policy.priorities.upgradeIntensity
            : null;
        if (requiredWork > 0 && upgradeIntensity === 'LOW') {
            requiredWork = Math.max(1, Math.floor(requiredWork * 0.5));
        } else if (requiredWork > 0 && upgradeIntensity === 'HIGH') {
            requiredWork = Math.max(requiredWork + 1, Math.ceil(requiredWork * 1.5));
        }

        mission.priority = opState === 'EMERGENCY' ? Math.max(90, upgradePriority) : upgradePriority;
        mission.meta.spawnAllowed = spawnAllowed;
        mission.requirements = {
            archetype: 'upgrader',
            requiredWork,
            minCount,
            maxCount,
            spawn: spawnAllowed,
            spawnFromFleet: true
        };
        mission.demand = {
            role: 'upgrader',
            count: Math.max(0, minCount - assignedCount),
            bodyProfile: 'upgrader'
        };

        if (controller && Number.isFinite(controller.progress)) {
            const prev = Number.isFinite(mission.progress.lastProgress) ? mission.progress.lastProgress : controller.progress;
            if (controller.progress > prev) mission.lastProgressTick = Game.time;
            mission.progress.lastProgress = controller.progress;
        }
    },

    isComplete() {
        return false;
    },

    toContractMission(mission) {
        const req = mission.requirements || {};
        return {
            name: mission.meta && mission.meta.missionName ? mission.meta.missionName : 'upgrade:controller',
            type: 'upgrade',
            archetype: 'upgrader',
            targetId: mission.targetId,
            data: {
                sourceIds: mission.data && Array.isArray(mission.data.sourceIds) ? mission.data.sourceIds : []
            },
            requirements: {
                archetype: 'upgrader',
                requiredWork: Number.isFinite(req.requiredWork) ? req.requiredWork : 1,
                minCount: Number.isFinite(req.minCount) ? req.minCount : 1,
                maxCount: Number.isFinite(req.maxCount) ? req.maxCount : 1,
                spawn: req.spawn !== false,
                spawnFromFleet: true
            },
            priority: Number.isFinite(mission.priority) ? mission.priority : 50
        };
    }
};


