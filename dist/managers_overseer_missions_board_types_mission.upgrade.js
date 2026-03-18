const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');

const CRITICAL_DOWNGRADE_TICKS = 5000;

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
        const variant = context.idle ? 'idle' : 'primary';
        return missionKeys.makeUpgradeKey(roomName, variant);
    },

    reconcileRoom({ room, intel, context, missionBoard }) {
        if (!room || !missionBoard) return;
        if (!intel || !intel.controller || !intel.controller.my) return;
        if (context && context.opState === 'EMERGENCY') return;
        if (missionThrottle.shouldRunReconcile('upgrade', room.name, Game.time)) {
            missionBoard.createMission('upgrade', {
                sponsorRoom: room.name,
                targetRoom: room.name,
                controllerId: intel.controller.id,
                idle: false,
                priority: 50
            }, { room, intel, context });
        }

        if (missionThrottle.shouldRunReconcile('upgrade', `${room.name}:idle`, Game.time)) {
            missionBoard.createMission('upgrade', {
                sponsorRoom: room.name,
                targetRoom: room.name,
                controllerId: intel.controller.id,
                idle: true,
                priority: -100
            }, { room, intel, context });
        }
    },

    create(context) {
        const now = Game.time;
        const idle = !!context.idle;
        return {
            id: this.makeKey(context),
            key: this.makeKey(context),
            type: 'upgrade',
            class: missionClasses.SERVICE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.targetRoom || context.sponsorRoom,
            priority: Number.isFinite(context.priority) ? context.priority : (idle ? -100 : 50),
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: context.controllerId || null,
            assigned: { primary: [], support: [] },
            demand: { role: 'upgrader', count: 0, bodyProfile: 'upgrader' },
            progress: { stage: 'upgrading', lastProgress: 0 },
            meta: {
                idle,
                missionName: idle ? 'idle:upgrade' : 'upgrade:controller',
                spawnAllowed: !idle
            },
            statusReason: null
        };
    },

    validate(mission, runtimeCtx) {
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
        const idle = !!(mission.meta && mission.meta.idle);
        const controller = room && room.controller ? room.controller : null;

        if (controller) mission.targetId = controller.id;

        mission.data = {
            sourceIds: intel && Array.isArray(intel.allEnergySources) ? intel.allEnergySources.map(s => s.id) : []
        };

        if (idle) {
            const maxSpaces = getMaxSpaces(intel);
            mission.priority = -100;
            mission.meta.spawnAllowed = false;
            mission.requirements = {
                archetype: 'upgrader',
                minCount: 0,
                maxCount: maxSpaces,
                spawn: false,
                spawnFromFleet: false
            };
            mission.demand = { role: 'upgrader', count: 0, bodyProfile: 'upgrader' };
            return;
        }

        const opState = context.opState || 'NORMAL';
        const economyState = context.economyState || (intel && intel.economyState) || 'STOCKPILING';
        const budget = Number.isFinite(context.budget) ? context.budget : ((room && room.energyCapacityAvailable) || 300);
        const assignedCount = mission.assigned.primary.length;
        const ticksToDowngrade = controller && Number.isFinite(controller.ticksToDowngrade) ? controller.ticksToDowngrade : 999999;
        const isCritical = ticksToDowngrade < CRITICAL_DOWNGRADE_TICKS;

        let upgradePriority = 50;
        let desiredWork = 15;
        if (controller && controller.level < 3) desiredWork = 8;
        let spawnAllowed = true;

        if (economyState === 'STOCKPILING') {
            desiredWork = 1;
            upgradePriority = 10;
            spawnAllowed = isCritical;
            if (isCritical) upgradePriority = 100;
        }

        if (intel && Array.isArray(intel.constructionSites) && intel.constructionSites.length > 0) {
            desiredWork = 1;
            upgradePriority = 20;
        }

        let requiredWork = desiredWork;
        let minCount = desiredWork > 0 ? 1 : 0;
        let maxCount = Math.max(1, Math.min(getMaxSpaces(intel), Number.isFinite(budget) ? getMaxSpaces(intel) : 1));
        if (economyState === 'STOCKPILING' && !isCritical) {
            requiredWork = 0;
            minCount = Math.min(assignedCount, maxCount);
            maxCount = minCount;
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
        const idle = !!(mission.meta && mission.meta.idle);
        const req = mission.requirements || {};
        return {
            name: mission.meta && mission.meta.missionName ? mission.meta.missionName : (idle ? 'idle:upgrade' : 'upgrade:controller'),
            type: 'upgrade',
            archetype: 'upgrader',
            targetId: mission.targetId,
            data: {
                sourceIds: mission.data && Array.isArray(mission.data.sourceIds) ? mission.data.sourceIds : []
            },
            requirements: idle ? {
                archetype: 'upgrader',
                minCount: Number.isFinite(req.minCount) ? req.minCount : 0,
                maxCount: Number.isFinite(req.maxCount) ? req.maxCount : 1,
                spawn: false,
                spawnFromFleet: false
            } : {
                archetype: 'upgrader',
                requiredWork: Number.isFinite(req.requiredWork) ? req.requiredWork : 1,
                minCount: Number.isFinite(req.minCount) ? req.minCount : 1,
                maxCount: Number.isFinite(req.maxCount) ? req.maxCount : 1,
                spawn: req.spawn !== false,
                spawnFromFleet: true
            },
            priority: Number.isFinite(mission.priority) ? mission.priority : (idle ? -100 : 50)
        };
    }
};


