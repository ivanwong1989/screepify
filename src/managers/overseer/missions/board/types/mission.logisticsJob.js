const missionStates = require('managers_overseer_missions_board_missionStates');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');

function cleanupAssigned(mission) {
    if (!mission.assigned) mission.assigned = { primary: [], support: [] };
    if (!Array.isArray(mission.assigned.primary)) mission.assigned.primary = [];
    mission.assigned.primary = mission.assigned.primary.filter(name => !!Game.creeps[name]);
}

function buildGoalContract(mission, kind) {
    if (kind === 'supply') {
        return {
            kind: 'finite',
            target: {
                kind: 'structure_supply',
                roomName: mission.targetRoom || mission.sponsorRoom,
                id: mission.targetId
            },
            success: {
                kind: 'target_filled_or_blocked'
            }
        };
    }
    if (kind === 'stock') {
        return {
            kind: 'finite',
            target: {
                kind: 'stock_rebalance',
                roomName: mission.targetRoom || mission.sponsorRoom,
                sourceId: mission.meta && mission.meta.sourceId ? mission.meta.sourceId : null,
                targetId: mission.meta && mission.meta.targetId ? mission.meta.targetId : mission.targetId
            },
            success: {
                kind: 'source_or_target_stock_reached',
                amountThreshold: mission.meta && Number.isFinite(mission.meta.amountThreshold)
                    ? mission.meta.amountThreshold
                    : 0,
                targetMin: mission.meta && Number.isFinite(mission.meta.targetMin)
                    ? mission.meta.targetMin
                    : null,
                targetMax: mission.meta && Number.isFinite(mission.meta.targetMax)
                    ? mission.meta.targetMax
                    : null
            }
        };
    }
    return {
        kind: 'finite',
        target: {
            kind: 'pickup_to_sink',
            roomName: mission.targetRoom || mission.sponsorRoom,
            sourceId: mission.meta && mission.meta.sourceId ? mission.meta.sourceId : null,
            targetId: mission.meta && mission.meta.targetId ? mission.meta.targetId : mission.targetId
        },
        success: {
            kind: 'source_drained_to_threshold',
            amountThreshold: mission.meta && Number.isFinite(mission.meta.amountThreshold)
                ? mission.meta.amountThreshold
                : 0
        }
    };
}

function ensureGoalContract(mission) {
    const kind = mission.meta && mission.meta.kind ? mission.meta.kind : 'supply';
    if (!mission.goal || typeof mission.goal !== 'object') {
        mission.goal = buildGoalContract(mission, kind);
        return;
    }
    if (kind === 'supply') {
        mission.goal.kind = mission.goal.kind || 'finite';
        mission.goal.target = mission.goal.target || {};
        mission.goal.target.kind = mission.goal.target.kind || 'structure_supply';
        mission.goal.target.roomName = mission.goal.target.roomName || mission.targetRoom || mission.sponsorRoom;
        mission.goal.target.id = mission.goal.target.id || mission.targetId;
        mission.goal.success = mission.goal.success || {};
        mission.goal.success.kind = mission.goal.success.kind || 'target_filled_or_blocked';
        return;
    }
    if (kind === 'stock') {
        mission.goal.kind = mission.goal.kind || 'finite';
        mission.goal.target = mission.goal.target || {};
        mission.goal.target.kind = mission.goal.target.kind || 'stock_rebalance';
        mission.goal.target.roomName = mission.goal.target.roomName || mission.targetRoom || mission.sponsorRoom;
        mission.goal.target.sourceId = mission.goal.target.sourceId || (mission.meta && mission.meta.sourceId) || null;
        mission.goal.target.targetId = mission.goal.target.targetId || (mission.meta && mission.meta.targetId) || mission.targetId || null;
        mission.goal.success = mission.goal.success || {};
        mission.goal.success.kind = mission.goal.success.kind || 'source_or_target_stock_reached';
        mission.goal.success.amountThreshold = Number.isFinite(mission.goal.success.amountThreshold)
            ? mission.goal.success.amountThreshold
            : (mission.meta && Number.isFinite(mission.meta.amountThreshold) ? mission.meta.amountThreshold : 0);
        mission.goal.success.targetMin = Number.isFinite(mission.goal.success.targetMin)
            ? mission.goal.success.targetMin
            : (mission.meta && Number.isFinite(mission.meta.targetMin) ? mission.meta.targetMin : null);
        mission.goal.success.targetMax = Number.isFinite(mission.goal.success.targetMax)
            ? mission.goal.success.targetMax
            : (mission.meta && Number.isFinite(mission.meta.targetMax) ? mission.meta.targetMax : null);
        return;
    }

    mission.goal.kind = mission.goal.kind || 'finite';
    mission.goal.target = mission.goal.target || {};
    mission.goal.target.kind = mission.goal.target.kind || 'pickup_to_sink';
    mission.goal.target.roomName = mission.goal.target.roomName || mission.targetRoom || mission.sponsorRoom;
    mission.goal.target.sourceId = mission.goal.target.sourceId || (mission.meta && mission.meta.sourceId) || null;
    mission.goal.target.targetId = mission.goal.target.targetId || (mission.meta && mission.meta.targetId) || mission.targetId || null;
    mission.goal.success = mission.goal.success || {};
    mission.goal.success.kind = mission.goal.success.kind || 'source_drained_to_threshold';
    mission.goal.success.amountThreshold = Number.isFinite(mission.goal.success.amountThreshold)
        ? mission.goal.success.amountThreshold
        : (mission.meta && Number.isFinite(mission.meta.amountThreshold) ? mission.meta.amountThreshold : 0);
}

function updateProgress(mission) {
    const kind = mission.meta && mission.meta.kind ? mission.meta.kind : 'supply';
    mission.progress = mission.progress || {};
    mission.progress.stage = kind;
    mission.progress.goalState = mission.assigned.primary.length > 0 ? 'executing' : 'awaiting_assignment';
    mission.progress.assignedPrimary = mission.assigned.primary.length;
}

module.exports = {
    makeKey(context) {
        return missionKeys.makeLogisticsJobKey(
            context.targetRoom || context.sponsorRoom,
            context.kind,
            context.targetId,
            context.sourceId || null,
            context.resourceType || RESOURCE_ENERGY
        );
    },

    create(context) {
        const now = Game.time;
        const kind = context.kind || 'supply';
        const rt = context.resourceType || RESOURCE_ENERGY;
        return {
            id: this.makeKey(context),
            key: this.makeKey(context),
            type: 'logisticsJob',
            class: missionClasses.FINITE,
            state: missionStates.ACTIVE,
            sponsorRoom: context.sponsorRoom,
            targetRoom: context.targetRoom || context.sponsorRoom,
            priority: Number.isFinite(context.priority) ? context.priority : (kind === 'supply' ? 80 : 45),
            createdTick: now,
            updatedTick: now,
            lastCheckedTick: 0,
            lastProgressTick: now,
            targetId: context.targetId,
            assigned: { primary: [], support: [] },
            demand: { role: 'hauler', count: 1, bodyProfile: 'hauler' },
            goal: kind === 'supply' ? {
                kind: 'finite',
                target: {
                    kind: 'structure_supply',
                    roomName: context.targetRoom || context.sponsorRoom,
                    id: context.targetId
                },
                success: {
                    kind: 'target_filled_or_blocked'
                }
            } : (kind === 'stock' ? {
                kind: 'finite',
                target: {
                    kind: 'stock_rebalance',
                    roomName: context.targetRoom || context.sponsorRoom,
                    sourceId: context.sourceId || null,
                    targetId: context.targetId
                },
                success: {
                    kind: 'source_or_target_stock_reached',
                    amountThreshold: Number.isFinite(context.amountThreshold) ? context.amountThreshold : 0,
                    targetMin: Number.isFinite(context.targetMin) ? context.targetMin : null,
                    targetMax: Number.isFinite(context.targetMax) ? context.targetMax : null
                }
            } : {
                kind: 'finite',
                target: {
                    kind: 'pickup_to_sink',
                    roomName: context.targetRoom || context.sponsorRoom,
                    sourceId: context.sourceId || null,
                    targetId: context.targetId
                },
                success: {
                    kind: 'source_drained_to_threshold',
                    amountThreshold: Number.isFinite(context.amountThreshold) ? context.amountThreshold : 0
                }
            }),
            progress: {
                stage: kind,
                goalState: 'awaiting_assignment',
                assignedPrimary: 0
            },
            meta: {
                kind,
                sourceId: context.sourceId || null,
                targetId: context.targetId,
                resourceType: rt,
                supplyClass: kind === 'supply'
                    ? ((context.supplyClass === 'aux') ? 'aux' : 'critical')
                    : null,
                amountThreshold: Number.isFinite(context.amountThreshold) ? context.amountThreshold : 0,
                amountHint: Number.isFinite(context.amountHint) ? Math.max(0, Math.floor(context.amountHint)) : null,
                targetMin: Number.isFinite(context.targetMin) ? context.targetMin : null,
                targetMax: Number.isFinite(context.targetMax) ? context.targetMax : null,
                legacyName: kind === 'supply'
                    ? `supply:${context.targetId}`
                    : `haul:${context.sourceId}:${context.targetId}:${rt}:s0`,
                allowPartial: context.allowPartial !== false
            },
            statusReason: null
        };
    },

    validate(mission) {
        const kind = mission.meta && mission.meta.kind;
        const target = mission.meta && mission.meta.targetId ? Game.getObjectById(mission.meta.targetId) : null;
        if (!target) return false;
        if (kind === 'pickup' || kind === 'stock') {
            const source = mission.meta && mission.meta.sourceId ? Game.getObjectById(mission.meta.sourceId) : null;
            return !!source;
        }
        return true;
    },

    refresh(mission) {
        cleanupAssigned(mission);
        ensureGoalContract(mission);
        if (mission.meta && mission.meta.kind === 'supply') {
            mission.meta.supplyClass = (mission.meta.supplyClass === 'aux') ? 'aux' : 'critical';
        }
        mission.demand = {
            role: 'hauler',
            count: Math.max(0, 1 - mission.assigned.primary.length),
            bodyProfile: 'hauler'
        };
        updateProgress(mission);
    },

    isComplete(mission) {
        const kind = mission.meta && mission.meta.kind;
        const rt = (mission.meta && mission.meta.resourceType) || RESOURCE_ENERGY;
        const target = mission.meta && mission.meta.targetId ? Game.getObjectById(mission.meta.targetId) : null;
        if (!target) return true;

        if (kind === 'supply') {
            if (!target.store || typeof target.store.getFreeCapacity !== 'function') return true;
            return target.store.getFreeCapacity(rt) <= 0;
        }

        if (kind === 'stock') {
            const source = mission.meta && mission.meta.sourceId ? Game.getObjectById(mission.meta.sourceId) : null;
            if (!source) return true;

            let sourceAmount = 0;
            if (source.store) sourceAmount = source.store[rt] || 0;
            else if (source.resourceType === rt && Number.isFinite(source.amount)) sourceAmount = source.amount;

            let targetAmount = 0;
            if (target.store) targetAmount = target.store[rt] || 0;
            else if (target.resourceType === rt && Number.isFinite(target.amount)) targetAmount = target.amount;

            const sourceThreshold = Number.isFinite(mission.meta && mission.meta.amountThreshold)
                ? mission.meta.amountThreshold
                : 0;
            const targetMin = Number.isFinite(mission.meta && mission.meta.targetMin)
                ? mission.meta.targetMin
                : null;
            const targetMax = Number.isFinite(mission.meta && mission.meta.targetMax)
                ? mission.meta.targetMax
                : null;

            if (sourceAmount <= sourceThreshold) return true;
            if (Number.isFinite(targetMin) && targetAmount >= targetMin) return true;
            if (Number.isFinite(targetMax) && targetAmount <= targetMax) return true;
            return false;
        }

        const source = mission.meta && mission.meta.sourceId ? Game.getObjectById(mission.meta.sourceId) : null;
        if (!source) return true;
        let amount = 0;
        if (source.store) amount = source.store[rt] || 0;
        else if (source.resourceType === rt && Number.isFinite(source.amount)) amount = source.amount;

        const threshold = Number.isFinite(mission.meta && mission.meta.amountThreshold)
            ? mission.meta.amountThreshold
            : 0;
        return amount <= threshold;
    },

    toLegacyMission(mission) {
        const kind = mission.meta && mission.meta.kind;
        const rt = (mission.meta && mission.meta.resourceType) || RESOURCE_ENERGY;
        if (kind === 'supply') {
            return {
                name: mission.meta && mission.meta.legacyName ? mission.meta.legacyName : `supply:${mission.targetId}`,
                type: 'transfer',
                archetype: 'hauler',
                targetId: mission.targetId,
                data: { resourceType: rt, mode: 'supply' },
                requirements: { archetype: 'hauler', minCount: 1, maxCount: 1, spawn: false },
                priority: mission.priority || 80
            };
        }

        return {
            name: mission.meta && mission.meta.legacyName
                ? mission.meta.legacyName
                : `haul:${mission.meta.sourceId}:${mission.meta.targetId}:${rt}:s0`,
            type: 'transfer',
            archetype: 'hauler',
            targetId: mission.meta && mission.meta.targetId ? mission.meta.targetId : mission.targetId,
            data: {
                sourceId: mission.meta && mission.meta.sourceId ? mission.meta.sourceId : null,
                resourceType: rt,
                allowPartial: !!(mission.meta && mission.meta.allowPartial),
                amountHint: Number.isFinite(mission.meta && mission.meta.amountHint)
                    ? Math.max(0, Math.floor(mission.meta.amountHint))
                    : undefined
            },
            requirements: { archetype: 'hauler', minCount: 1, maxCount: 1, spawn: false },
            priority: mission.priority || 45
        };
    }
};
