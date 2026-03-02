const helpers = require('managers_overseer_tasks_exec__helpers');
const execGatherTask = require('managers_overseer_tasks_exec_gather');

module.exports = function execTransferTask(ctx) {
    const { creep, mission, room } = ctx;
    const resourceType = (mission.data && mission.data.resourceType) ? mission.data.resourceType : RESOURCE_ENERGY;
    const isSupply = !!(mission.data && mission.data.mode === 'supply');
    const allowPartial = !!(mission.data && mission.data.allowPartial);
    const EMPTY_SOURCE_TIMEOUT = 20;
    const previousState = creep.memory.taskState;
    const debug = !!(mission.data && mission.data.debug) || (Memory.debugTransfer === true);
    const log = (msg) => {
        if (!debug) return;
        console.log(`[Transfer:${creep.name}] ${msg}`);
    };

    const findOtherDumpTarget = (type) => {
        // For "dump-other", prefer stable sinks to avoid oscillation loops (e.g., dumping into containers then re-withdrawing).
        if (!type) return null;
        if (room.storage && room.storage.store && room.storage.store.getFreeCapacity(type) > 0) return room.storage;
        if (room.terminal && room.terminal.store && room.terminal.store.getFreeCapacity(type) > 0) return room.terminal;
        return null;
    };

    const findDumpTarget = (type) => {
        if (!type) return null;
        if (room.storage && room.storage.store.getFreeCapacity(type) > 0) return room.storage;
        if (room.terminal && room.terminal.store.getFreeCapacity(type) > 0) return room.terminal;

        if (mission.targetId) {
            const target = helpers.getCachedObject(creep.room, mission.targetId);
            if (target && target.store && typeof target.store.getFreeCapacity === 'function') {
                if (![STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_TOWER].includes(target.structureType)) {
                    if (target.store.getFreeCapacity(type) > 0) return target;
                }
            }
        }

        const cache = global.getRoomCache ? global.getRoomCache(room) : null;
        const containers = cache && cache.structuresByType ? (cache.structuresByType[STRUCTURE_CONTAINER] || []) : [];
        const candidates = containers.filter(c => c.store && c.store.getFreeCapacity(type) > 0);
        return creep.pos.findClosestByRange(candidates);
    };

    for (const type in creep.store) {
        if (type === resourceType) continue;
        if ((creep.store[type] || 0) <= 0) continue;
        const dumpTarget = findOtherDumpTarget(type) || findDumpTarget(type);
        if (dumpTarget) {
            log(`dump-other ${type} -> ${dumpTarget.id}`);
            return { type: 'transfer', targetId: dumpTarget.id, resourceType: type };
        }
    }

    // Default behavior was requireFull=true for non-supply missions.
    // For certain logistics routes (e.g., link_out / small scavenges), we want to allow partial loads
    // so big haulers don't stall or abort when the source amount is small.
    helpers.updateState(creep, resourceType, { requireFull: !allowPartial, allowPartialWork: isSupply || allowPartial });

    if (!isSupply && previousState === 'working' && creep.memory.taskState === 'gathering') {
        log(`abort flip working->gathering (non-supply)`);
        delete creep.memory.missionName;
        delete creep.memory.taskState;
        return null;
    }

    if (creep.memory.taskState === 'working') {
        if (creep.memory._emptySourceTicks) delete creep.memory._emptySourceTicks;
        let target = null;

        if (resourceType === RESOURCE_ENERGY &&
            mission.targetType === 'transfer_list' &&
            mission.data &&
            mission.data.targetIds) {
            const targets = mission.data.targetIds
                .map(id => helpers.getCachedObject(creep.room, id))
                .filter(t => t && t.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
            target = creep.pos.findClosestByRange(targets);
        }

        if (!target && mission.targetId) {
            target = helpers.getCachedObject(creep.room, mission.targetId);
        }

        if (target) {
            if (target.store && target.store.getFreeCapacity(resourceType) === 0) {
                log(`abort target full ${resourceType} ${target.id}`);
                delete creep.memory.missionName;
                delete creep.memory.taskState;
                return null;
            }
            log(`deliver ${resourceType} -> ${target.id}`);
            return { type: 'transfer', targetId: target.id, resourceType: resourceType };
        }

        if (resourceType !== RESOURCE_ENERGY) {
            log(`abort no target for non-energy ${resourceType}`);
            delete creep.memory.missionName;
            delete creep.memory.taskState;
            return null;
        }

        log(`abort no target (energy)`);
        delete creep.memory.missionName;
        delete creep.memory.taskState;
        return null;
    }

    if (resourceType !== RESOURCE_ENERGY && mission.data && mission.data.sourceId) {
        const source = helpers.getCachedObject(creep.room, mission.data.sourceId);
        if (source instanceof Resource) {
            if (source.resourceType === resourceType && source.amount > 0) {
                if (creep.memory._emptySourceTicks) delete creep.memory._emptySourceTicks;
                log(`pickup ${resourceType} from resource ${source.id}`);
                return { type: 'pickup', targetId: source.id };
            }
        } else if (source && source.store && (source.store[resourceType] || 0) > 0) {
            if (creep.memory._emptySourceTicks) delete creep.memory._emptySourceTicks;
            log(`withdraw ${resourceType} from ${source.id}`);
            return { type: 'withdraw', targetId: source.id, resourceType: resourceType };
        }
        if (creep.store.getUsedCapacity(resourceType) > 0) {
            log(`source empty but already carrying ${resourceType}, switch to working`);
            creep.memory.taskState = 'working';
            return execTransferTask(ctx);
        }
        log(`abort source empty ${resourceType} sourceId=${mission.data && mission.data.sourceId}`);
        delete creep.memory.missionName;
        delete creep.memory.taskState;
        return null;
    }

    let task = null;

    // IMPORTANT: execGatherTask is ENERGY-only. For non-energy missions we must not "side-quest" into energy gathering.
    if (resourceType !== RESOURCE_ENERGY) {
        // If we already have the mission resource, just deliver it.
        if (creep.store.getUsedCapacity(resourceType) > 0) {
            log(`no source task but carrying ${resourceType}, switch to working`);
            creep.memory.taskState = 'working';
            return execTransferTask(ctx);
        }

        // If we have a list of allowed sources, try to withdraw/pickup the specific resourceType from them.
        const ids = (mission.data && mission.data.sourceIds) ? mission.data.sourceIds : null;
        if (ids && ids.length > 0) {
            const candidates = ids
                .map(id => helpers.getCachedObject(creep.room, id))
                .filter(o => o)
                .filter(o => {
                    if (o instanceof Resource) return o.resourceType === resourceType && o.amount > 0;
                    if (o.store) return (o.store[resourceType] || 0) > 0;
                    return false;
                });

            const chosen = creep.pos.findClosestByRange(candidates);
            if (chosen) {
                log(`gather ${resourceType} from ${chosen.id}`);
                if (chosen instanceof Resource) return { type: 'pickup', targetId: chosen.id };
                return { type: 'withdraw', targetId: chosen.id, resourceType: resourceType };
            }
        }

        log(`abort no source for non-energy ${resourceType}`);
        delete creep.memory.missionName;
        delete creep.memory.taskState;
        return null;
    }

    // Energy missions may use the generic gather selector.
    if (mission.data && mission.data.sourceId) {
        task = execGatherTask({ creep, room, options: { allowedIds: [mission.data.sourceId] } });
    } else {
        const allowedIds = (mission.data && mission.data.sourceIds) ? mission.data.sourceIds : null;
        const excludeIds = (mission.data && mission.data.targetIds) ? mission.data.targetIds : null;
        task = execGatherTask({ creep, room, options: { allowedIds, excludeIds, preferNearestAvailable: isSupply } });
    }

    if (task) {
        if (creep.memory._emptySourceTicks) delete creep.memory._emptySourceTicks;
        log(`gather task ${task.type} -> ${task.targetId || ''}`);
        return task;
    }

    if (creep.store.getUsedCapacity(resourceType) > 0) {
        log(`no gather task but carrying ${resourceType}, switch to working`);
        creep.memory.taskState = 'working';
        return execTransferTask(ctx);
    }

    if (resourceType === RESOURCE_ENERGY && mission.data && mission.data.sourceId) {
        const source = helpers.getCachedObject(creep.room, mission.data.sourceId);
        const ticks = (creep.memory._emptySourceTicks || 0) + 1;
        creep.memory._emptySourceTicks = ticks;

        if (ticks < EMPTY_SOURCE_TIMEOUT) {
            if (source) {
                log(`wait at source ${source.id} ticks=${ticks}`);
                return { type: 'move', targetId: source.id, range: 1 };
            }
            log(`wait no source ticks=${ticks}`);
            return null;
        }

        delete creep.memory._emptySourceTicks;
    }

    log(`abort no task`);
    delete creep.memory.missionName;
    delete creep.memory.taskState;
    return null;
};
