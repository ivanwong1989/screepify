const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');

function cleanupAssigned(mission) {
    if (!mission.assigned) mission.assigned = { primary: [], support: [] };
    if (!Array.isArray(mission.assigned.primary)) mission.assigned.primary = [];
    mission.assigned.primary = mission.assigned.primary.filter(name => !!Game.creeps[name]);
}

function buildGoalContract(mission) {
    return {
        kind: 'finite',
        target: {
            kind: 'logistics_lane',
            roomName: mission.targetRoom || mission.sponsorRoom,
            sourceId: mission.meta && mission.meta.sourceId ? mission.meta.sourceId : null,
            targetId: mission.meta && mission.meta.targetId ? mission.meta.targetId : mission.targetId
        },
        success: {
            kind: 'source_below_min_amount'
        },
        persistWhile: {
            endpointsExist: true
        }
    };
}

function ensureGoalContract(mission) {
    if (!mission.goal || typeof mission.goal !== 'object') {
        mission.goal = buildGoalContract(mission);
        return;
    }
    mission.goal.kind = mission.goal.kind || 'finite';
    mission.goal.target = mission.goal.target || {};
    mission.goal.target.kind = mission.goal.target.kind || 'logistics_lane';
    mission.goal.target.roomName = mission.goal.target.roomName || mission.targetRoom || mission.sponsorRoom;
    mission.goal.target.sourceId = mission.goal.target.sourceId || (mission.meta && mission.meta.sourceId) || null;
    mission.goal.target.targetId = mission.goal.target.targetId || (mission.meta && mission.meta.targetId) || mission.targetId || null;
    mission.goal.success = mission.goal.success || {};
    mission.goal.success.kind = mission.goal.success.kind || 'source_below_min_amount';
    mission.goal.persistWhile = mission.goal.persistWhile || {};
    if (mission.goal.persistWhile.endpointsExist !== true) mission.goal.persistWhile.endpointsExist = true;
}

function updateProgress(mission) {
    mission.progress = mission.progress || {};
    mission.progress.stage = 'lane';
    mission.progress.goalState = mission.assigned.primary.length > 0 ? 'sustaining' : 'seeking_assignment';
    mission.progress.assignedPrimary = mission.assigned.primary.length;
}

function getSourceAmount(source, resourceType) {
    if (!source) return 0;
    if (source.store) return source.store[resourceType] || 0;
    if (source.resourceType === resourceType && Number.isFinite(source.amount)) return source.amount;
    return 0;
}

module.exports = {
    makeKey(context) {
        return missionKeys.makeLogisticsLaneKey(
            context.targetRoom || context.sponsorRoom,
            context.sourceId,
            context.targetId,
            context.resourceType || RESOURCE_ENERGY,
            context.slot
        );
    },

    create(context) {
        const now = Game.time;
        const rt = context.resourceType || RESOURCE_ENERGY;
        const slot = Number.isFinite(context.slot) ? context.slot : 0;
        return {
            id: this.makeKey(context),
            key: this.makeKey(context),
            type: 'logisticsLane',
            class: missionClasses.FINITE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.targetRoom || context.sponsorRoom,
            priority: Number.isFinite(context.priority) ? context.priority : 85,
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: context.targetId,
            assigned: { primary: [], support: [] },
            demand: { role: 'hauler', count: 1, bodyProfile: 'hauler' },
            goal: {
                kind: 'finite',
                target: {
                    kind: 'logistics_lane',
                    roomName: context.targetRoom || context.sponsorRoom,
                    sourceId: context.sourceId,
                    targetId: context.targetId
                },
                success: {
                    kind: 'source_below_min_amount'
                },
                persistWhile: {
                    endpointsExist: true
                }
            },
            progress: {
                stage: 'lane',
                goalState: 'seeking_assignment',
                assignedPrimary: 0
            },
            meta: {
                sourceId: context.sourceId,
                targetId: context.targetId,
                resourceType: rt,
                slot,
                laneType: context.laneType || 'mining',
                minAmount: Number.isFinite(context.minAmount) ? Math.max(0, Math.floor(context.minAmount)) : null,
                missionName: `haul:${context.sourceId}:${context.targetId}:${rt}:s${slot}`,
                allowPartial: !!context.allowPartial
            },
            statusReason: null
        };
    },

    validate(mission) {
        const source = mission.meta && mission.meta.sourceId ? Game.getObjectById(mission.meta.sourceId) : null;
        const target = mission.meta && mission.meta.targetId ? Game.getObjectById(mission.meta.targetId) : null;
        return !!(source && target);
    },

    refresh(mission) {
        cleanupAssigned(mission);
        ensureGoalContract(mission);
        if (mission.meta) {
            mission.meta.minAmount = Number.isFinite(mission.meta.minAmount)
                ? Math.max(0, Math.floor(mission.meta.minAmount))
                : null;
        }
        const source = mission.meta && mission.meta.sourceId ? Game.getObjectById(mission.meta.sourceId) : null;
        if (!source) return;
        if (source.store) {
            const rt = mission.meta.resourceType || RESOURCE_ENERGY;
            const amount = source.store[rt] || 0;
            if (amount > 0) mission.lastProgressTick = Game.time;
        } else if (Number.isFinite(source.amount) && source.amount > 0) {
            mission.lastProgressTick = Game.time;
        }
        mission.demand = {
            role: 'hauler',
            count: Math.max(0, 1 - mission.assigned.primary.length),
            bodyProfile: 'hauler'
        };
        updateProgress(mission);
    },

    isComplete(mission) {
        const source = mission.meta && mission.meta.sourceId ? Game.getObjectById(mission.meta.sourceId) : null;
        const target = mission.meta && mission.meta.targetId ? Game.getObjectById(mission.meta.targetId) : null;
        if (!source || !target) return true;

        const rt = (mission.meta && mission.meta.resourceType) || RESOURCE_ENERGY;
        const amount = getSourceAmount(source, rt);
        // `minAmount` is a reconcile scheduling gate, not a completion gate.
        // Completing at `amount < minAmount` can orphan haulers carrying in-flight cargo.
        return amount <= 0;
    },

    toContractMission(mission) {
        const rt = (mission.meta && mission.meta.resourceType) || RESOURCE_ENERGY;
        return {
            name: mission.meta && mission.meta.missionName
                ? mission.meta.missionName
                : `haul:${mission.meta.sourceId}:${mission.meta.targetId}:${rt}:s0`,
            type: 'transfer',
            archetype: 'hauler',
            targetId: mission.meta && mission.meta.targetId ? mission.meta.targetId : mission.targetId,
            data: {
                sourceId: mission.meta && mission.meta.sourceId ? mission.meta.sourceId : null,
                resourceType: rt,
                allowPartial: !!(mission.meta && mission.meta.allowPartial)
            },
            requirements: {
                archetype: 'hauler',
                minCount: 1,
                maxCount: 1,
                spawn: false
            },
            priority: mission.priority || 80
        };
    }
};


