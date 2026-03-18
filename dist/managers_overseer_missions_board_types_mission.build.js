const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');

const BUILD_WORKER_TUNING = Object.freeze({
    desiredWorkBase: 1,
    desiredWorkScaleStartRcl: 5,
    desiredWorkPerRclAboveScaleStart: 1,
    desiredWorkMax: 2,
    minCount: 1,
    maxCount: 1
});

function getDesiredBuildWork(rcl) {
    const level = Number.isFinite(rcl) ? rcl : 1;
    const above = Math.max(0, level - BUILD_WORKER_TUNING.desiredWorkScaleStartRcl);
    const scaled = BUILD_WORKER_TUNING.desiredWorkBase + (above * BUILD_WORKER_TUNING.desiredWorkPerRclAboveScaleStart);
    return Math.max(1, Math.min(BUILD_WORKER_TUNING.desiredWorkMax, scaled));
}

function cleanupAssigned(mission) {
    if (!mission.assigned) mission.assigned = { primary: [], support: [] };
    if (!Array.isArray(mission.assigned.primary)) mission.assigned.primary = [];
    mission.assigned.primary = mission.assigned.primary.filter(name => !!Game.creeps[name]);
}

module.exports = {
    makeKey(context) {
        return missionKeys.makeBuildKey(context.targetRoom || context.sponsorRoom, context.siteId);
    },

    reconcileRoom({ room, intel, context, missionBoard }) {
        if (!room || !missionBoard) return;
        if (context && context.opState === 'EMERGENCY') return;
        if (!missionThrottle.shouldRunReconcile('build', room.name, Game.time)) return;

        const sites = intel && Array.isArray(intel.constructionSites)
            ? intel.constructionSites
            : room.find(FIND_MY_CONSTRUCTION_SITES);
        if (!sites || sites.length === 0) return;

        const rcl = (room.controller && room.controller.level) || 1;
        const requiredWork = getDesiredBuildWork(rcl);

        for (let i = 0; i < sites.length; i++) {
            const site = sites[i];
            if (!site || !site.id) continue;
            missionBoard.createMission('build', {
                sponsorRoom: room.name,
                targetRoom: room.name,
                siteId: site.id,
                requiredWork,
                priority: 60
            }, { room, intel, context });
        }
    },

    create(context) {
        const now = Game.time;
        return {
            id: this.makeKey(context),
            key: this.makeKey(context),
            type: 'build',
            class: missionClasses.FINITE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.targetRoom || context.sponsorRoom,
            priority: Number.isFinite(context.priority) ? context.priority : 60,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: context.siteId,
            assigned: { primary: [], support: [] },
            demand: { role: 'worker', count: 1, bodyProfile: 'worker' },
            progress: {
                stage: 'building',
                lastProgress: 0
            },
            meta: {
                missionName: `build:${context.siteId}`,
                requiredWork: Number.isFinite(context.requiredWork) ? context.requiredWork : getDesiredBuildWork(1),
                minCount: BUILD_WORKER_TUNING.minCount,
                maxCount: BUILD_WORKER_TUNING.maxCount
            },
            statusReason: null
        };
    },

    validate(mission, runtimeCtx) {
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        if (!room) return true;
        const site = Game.getObjectById(mission.targetId);
        return !!site;
    },

    refresh(mission, runtimeCtx) {
        cleanupAssigned(mission);
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        const intel = runtimeCtx && runtimeCtx.intel ? runtimeCtx.intel : null;
        const site = Game.getObjectById(mission.targetId);
        const rcl = (room && room.controller && room.controller.level) || 1;
        const requiredWork = getDesiredBuildWork(rcl);

        mission.meta = mission.meta || {};
        mission.meta.requiredWork = requiredWork;
        mission.meta.minCount = BUILD_WORKER_TUNING.minCount;
        mission.meta.maxCount = BUILD_WORKER_TUNING.maxCount;
        mission.meta.missionName = mission.meta.missionName || `build:${mission.targetId}`;

        mission.progress = mission.progress || {};
        if (site && Number.isFinite(site.progress)) {
            if (!Number.isFinite(mission.progress.lastProgress)) mission.progress.lastProgress = site.progress;
            if (site.progress > mission.progress.lastProgress) {
                mission.lastProgressTick = Game.time;
                mission.progress.lastProgress = site.progress;
            }
            mission.progress.total = site.progressTotal || 0;
        }

        mission.demand = {
            role: 'worker',
            count: Math.max(0, mission.meta.minCount - mission.assigned.primary.length),
            bodyProfile: 'worker'
        };

        mission.data = {
            sourceIds: intel && Array.isArray(intel.allEnergySources) ? intel.allEnergySources.map(s => s.id) : []
        };
    },

    isComplete(mission, runtimeCtx) {
        const roomName = mission.targetRoom || mission.sponsorRoom;
        const room = runtimeCtx && runtimeCtx.room ? runtimeCtx.room : Game.rooms[roomName];
        const site = Game.getObjectById(mission.targetId);
        if (site) return false;
        // If visible and site is gone, build is complete/removed.
        if (room) return true;
        return false;
    },

    toContractMission(mission) {
        return {
            name: mission.meta && mission.meta.missionName ? mission.meta.missionName : `build:${mission.targetId}`,
            type: 'build',
            archetype: 'worker',
            targetId: mission.targetId,
            data: {
                sourceIds: mission.data && Array.isArray(mission.data.sourceIds) ? mission.data.sourceIds : []
            },
            requirements: {
                archetype: 'worker',
                requiredWork: mission.meta && Number.isFinite(mission.meta.requiredWork) ? mission.meta.requiredWork : getDesiredBuildWork(1),
                minCount: mission.meta && Number.isFinite(mission.meta.minCount) ? mission.meta.minCount : BUILD_WORKER_TUNING.minCount,
                maxCount: mission.meta && Number.isFinite(mission.meta.maxCount) ? mission.meta.maxCount : BUILD_WORKER_TUNING.maxCount,
                spawnFromFleet: true
            },
            priority: mission.priority || 60
        };
    }
};


