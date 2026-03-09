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

    const fmtN = (v) => (v === undefined || v === null) ? '-' : String(v);
    const fmtTask = (t) => {
        if (!t) return 'null';
        const amt = (t.amount !== undefined && t.amount !== null) ? ` amt=${t.amount}` : '';
        const rt = (t.resourceType !== undefined && t.resourceType !== null) ? ` res=${t.resourceType}` : '';
        const tid = (t.targetId) ? ` -> ${t.targetId}` : '';
        return `${t.type}${rt}${amt}${tid}`;
    };

    // Amount hint (optional): used to cap per-action withdraw/transfer for "excess/need" routes.
    // Prevents big haulers from over-withdrawing (e.g., terminal overflow below stock target).
    const getAmountHint = () => {
        if (!mission || !mission.data) return null;
        const v = mission.data.amountHint;
        if (v === undefined || v === null) return null;
        const n = Number(v);
        if (!isFinite(n)) return null;
        if (n <= 0) return 0;
        return Math.floor(n);
    };

    const _hint = getAmountHint();
    if (_hint !== null) {
        creep.memory._haulHint = _hint;
    } else if (creep.memory._haulHint !== undefined) {
        delete creep.memory._haulHint;
    }

    const capByHintAndCapacity = (hint, capacity) => {
        if (hint === null) return null; // no cap
        if (hint <= 0) return 0;
        return Math.max(0, Math.min(hint, capacity));
    };

    
    const capByHintRemaining = (hint, carried, capacity) => {
        if (hint === null) return null; // no cap
        const rem = Math.max(0, hint - (carried || 0));
        return Math.max(0, Math.min(rem, capacity));
    };

    const getOpportunisticLocalTopUp = () => {
        if (resourceType !== RESOURCE_ENERGY || !allowPartial) return null;
        if (!mission || !mission.data || !mission.data.sourceId) return null;

        const carried = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        const free = creep.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
        if (carried <= 0 || free <= 0) return null;

        const anchor = helpers.getCachedObject(creep.room, mission.data.sourceId);
        if (!anchor || !anchor.pos) return null;
        if (!creep.pos.inRangeTo(anchor.pos, 1)) return null; // no extra walking

        const hint = getAmountHint();
        const remainingByHint = capByHintRemaining(hint, carried, free);
        if (remainingByHint === 0) return null;

        const maxTake = (available) => {
            const avail = Math.max(0, available || 0);
            if (remainingByHint === null) return Math.min(avail, free);
            return Math.min(avail, remainingByHint);
        };

        const tryBuildTask = (target) => {
            if (!target || !target.id) return null;
            if (target instanceof Resource) {
                if (target.resourceType !== RESOURCE_ENERGY || target.amount <= 0) return null;
                if (!target.pos || !target.pos.inRangeTo(anchor.pos, 1) || !creep.pos.inRangeTo(target.pos, 1)) return null;

                // pickup() cannot be amount-capped; skip when hint would be exceeded.
                const take = maxTake(target.amount);
                if (take <= 0) return null;
                if (remainingByHint !== null && target.amount > take) return null;
                return { type: 'pickup', targetId: target.id };
            }

            if (!target.store || !target.pos) return null;
            const available = target.store[RESOURCE_ENERGY] || 0;
            if (available <= 0) return null;
            if (!target.pos.inRangeTo(anchor.pos, 1) || !creep.pos.inRangeTo(target.pos, 1)) return null;

            const take = maxTake(available);
            if (take <= 0) return null;
            return { type: 'withdraw', targetId: target.id, resourceType: RESOURCE_ENERGY, amount: take };
        };

        // Prefer the anchored source first, then any adjacent no-walk energy blob/container.
        const anchorTask = tryBuildTask(anchor);
        if (anchorTask) return anchorTask;

        const dropped = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
            filter: r => r && r.id !== mission.data.sourceId && r.resourceType === RESOURCE_ENERGY && r.amount > 0 &&
                r.pos && r.pos.inRangeTo(anchor.pos, 1)
        });
        let bestDrop = null;
        for (let i = 0; i < dropped.length; i++) {
            const d = dropped[i];
            if (!bestDrop || d.amount > bestDrop.amount) bestDrop = d;
        }
        const dropTask = tryBuildTask(bestDrop);
        if (dropTask) return dropTask;

        const structures = creep.pos.findInRange(FIND_STRUCTURES, 1, {
            filter: s => s && s.id !== mission.data.sourceId && s.store && (s.store[RESOURCE_ENERGY] || 0) > 0 &&
                s.pos && s.pos.inRangeTo(anchor.pos, 1)
        });
        let bestStruct = null;
        for (let i = 0; i < structures.length; i++) {
            const s = structures[i];
            const amt = s.store[RESOURCE_ENERGY] || 0;
            if (!bestStruct || amt > (bestStruct.store[RESOURCE_ENERGY] || 0)) bestStruct = s;
        }
        return tryBuildTask(bestStruct);
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
            const carried = creep.store.getUsedCapacity(type) || 0;
            log(`dump-other ${type} -> ${dumpTarget.id} carried=${carried}`);
            return { type: 'transfer', targetId: dumpTarget.id, resourceType: type };
        }
    }

    // Default behavior was requireFull=true for non-supply missions.
    // For certain logistics routes (e.g., link_out / small scavenges), we want to allow partial loads
    // so big haulers don't stall or abort when the source amount is small.
    helpers.updateState(creep, resourceType, { requireFull: !allowPartial, allowPartialWork: isSupply || allowPartial });

    // --- Partial-route anti-pingpong "pressure" model ---
    // Goal: when allowPartial=true and we already carry some cargo (meaning we *could* deliver),
    // avoid endless re-deciding between different gather sources (pickup/withdraw targets).
    // We ONLY increase pressure when the gather decision CHANGES (type/target), not by elapsed ticks.
    const PRESSURE_KEY = '_transferPressure';
    const pressure = (creep.memory[PRESSURE_KEY] || (creep.memory[PRESSURE_KEY] = { flips: 0, lastSig: null }));
    const flipThreshold = (mission.data && typeof mission.data.partialFlipThreshold === 'number')
        ? mission.data.partialFlipThreshold
        : 2; // default: after 2 gather-decision flips, force delivery

    const resetPressure = () => {
        pressure.flips = 0;
        pressure.lastSig = null;
    };

    // Reset pressure when empty or when we're in delivery mode.
    if (creep.store.getUsedCapacity(resourceType) === 0 || creep.memory.taskState === 'working') {
        resetPressure();
    }

    // Resolve a delivery target WITHOUT mutating mission state.
    // Used only to decide whether "we actually could deliver now".
    const resolveDeliverTarget = () => {
        let t = null;

        if (resourceType === RESOURCE_ENERGY &&
            mission.targetType === 'transfer_list' &&
            mission.data &&
            mission.data.targetIds) {
            const targets = mission.data.targetIds
                .map(id => helpers.getCachedObject(creep.room, id))
                .filter(x => x && x.store && x.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
            t = creep.pos.findClosestByRange(targets);
            if (t) return t;
        }

        if (mission.targetId) {
            t = helpers.getCachedObject(creep.room, mission.targetId);
            if (t && t.store && typeof t.store.getFreeCapacity === 'function' && t.store.getFreeCapacity(resourceType) > 0) {
                return t;
            }
        }

        return null;
    };

    // If this mission has an amountHint, treat it as a *total* cap to move for this mission instance.
    // Once we already carry >= hint, stop withdrawing more and go deliver now (prevents draining past stockTargets).
    const hintNow = getAmountHint();
    if (hintNow !== null && !isSupply && creep.memory.taskState !== 'working') {
        const carriedNow = creep.store.getUsedCapacity(resourceType) || 0;
        if (carriedNow >= hintNow && carriedNow > 0) {
            log(`carry>=hint (${carriedNow}>=${hintNow}), force deliver`);
            creep.memory.taskState = 'working';
            return execTransferTask(ctx);
        }
    }


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
            const hint = getAmountHint();
            const carried = creep.store.getUsedCapacity(resourceType) || 0;
            // If we somehow carry more than the hint (shouldn't happen), only deliver up to the hint.
            const amt = capByHintAndCapacity(hint, carried);
            log(`deliver ${resourceType} -> ${target.id} carried=${carried} hint=${fmtN(hint)} amt=${fmtN(amt)}`);
            if (amt === 0) {
                // Nothing meaningful to deliver for hinted routes, abort mission cleanly.
                log(`abort deliver amountHint=0 for ${resourceType}`);
                delete creep.memory.missionName;
                delete creep.memory.taskState;
                return null;
            }
            return (amt !== null)
                ? { type: 'transfer', targetId: target.id, resourceType: resourceType, amount: amt }
                : { type: 'transfer', targetId: target.id, resourceType: resourceType };
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
            const hint = getAmountHint();
            const free = creep.store.getFreeCapacity(resourceType) || 0;
            const carried = creep.store.getUsedCapacity(resourceType) || 0;
            const amt = capByHintRemaining(hint, carried, free);
            log(`withdraw ${resourceType} from ${source.id} carried=${carried} free=${free} hint=${fmtN(hint)} amt=${fmtN(amt)}`);
            if (amt === 0) {
                // No remaining hinted amount -> if carrying, deliver; else abort.
                if (creep.store.getUsedCapacity(resourceType) > 0) {
                    log(`amountHint=0 but carrying ${resourceType}, switch to working`);
                    creep.memory.taskState = 'working';
                    return execTransferTask(ctx);
                }
                log(`abort withdraw amountHint=0 for ${resourceType}`);
                delete creep.memory.missionName;
                delete creep.memory.taskState;
                return null;
            }
            return (amt !== null)
                ? { type: 'withdraw', targetId: source.id, resourceType: resourceType, amount: amt }
                : { type: 'withdraw', targetId: source.id, resourceType: resourceType };
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

                const hint = getAmountHint();
                const free = creep.store.getFreeCapacity(resourceType) || 0;
                const carried = creep.store.getUsedCapacity(resourceType) || 0;
                const amt = capByHintRemaining(hint, carried, free);
                if (amt === 0) {
                    if (creep.store.getUsedCapacity(resourceType) > 0) {
                        log(`amountHint=0 but carrying ${resourceType}, switch to working`);
                        creep.memory.taskState = 'working';
                        return execTransferTask(ctx);
                    }
                    log(`abort withdraw amountHint=0 for ${resourceType}`);
                    delete creep.memory.missionName;
                    delete creep.memory.taskState;
                    return null;
                }

                return (amt !== null)
                    ? { type: 'withdraw', targetId: chosen.id, resourceType: resourceType, amount: amt }
                    : { type: 'withdraw', targetId: chosen.id, resourceType: resourceType };
            }
        }

        log(`abort no source for non-energy ${resourceType}`);
        delete creep.memory.missionName;
        delete creep.memory.taskState;
        return null;
    }

    // Energy missions may use the generic gather selector.
    if (resourceType === RESOURCE_ENERGY) {
        const topUpTask = getOpportunisticLocalTopUp();
        if (topUpTask) {
            if (creep.memory._emptySourceTicks) delete creep.memory._emptySourceTicks;
            log(`local top-up ${fmtTask(topUpTask)}`);
            return topUpTask;
        }

        // Supply missions: if storage exists, ONLY pull from storage (stable source, prevents mining-container yo-yo)
        if (isSupply && room.storage && (room.storage.store[RESOURCE_ENERGY] || 0) > 0) {
            task = execGatherTask({
                creep,
                room,
                options: {
                    allowedIds: [room.storage.id],
                    allowPartial: true,              // deliver as soon as we have any energy
                    preferNearestAvailable: false    // irrelevant when allowedIds is set, but keep explicit
                }
            });
        } else if (mission.data && mission.data.sourceId) {
            task = execGatherTask({ creep, room, options: { allowedIds: [mission.data.sourceId], allowPartial } });
        } else {
            const allowedIds = (mission.data && mission.data.sourceIds) ? mission.data.sourceIds : null;
            const excludeIds = (mission.data && mission.data.targetIds) ? mission.data.targetIds : null;
            task = execGatherTask({ creep, room, options: { allowedIds, excludeIds, preferNearestAvailable: isSupply, allowPartial } });
        }
    }

    
if (task) {
        if (creep.memory._emptySourceTicks) delete creep.memory._emptySourceTicks;

        // Pressure model: if allowPartial and we already carry some cargo, only allow a limited number
        // of "gather decision" flips (changing pickup/withdraw target) before we force delivery.
        if (allowPartial && creep.store.getUsedCapacity(resourceType) > 0) {
            const deliverTarget = resolveDeliverTarget();
            if (deliverTarget) {
                const sig = `${task.type}:${task.targetId || ''}`;
                if (pressure.lastSig && pressure.lastSig !== sig) {
                    pressure.flips++;
                    log(`pressure flip=${pressure.flips}/${flipThreshold} ${pressure.lastSig} -> ${sig}`);
                }
                pressure.lastSig = sig;

                if (pressure.flips >= flipThreshold) {
                    log(`pressure threshold reached, force deliver -> ${deliverTarget.id}`);
                    creep.memory.taskState = 'working';
                    resetPressure();
                    return execTransferTask(ctx);
                }
            } else {
                // If we can't actually deliver, don't penalize indecision.
                resetPressure();
            }
        }


        // If this is a hinted route and gather chose 'withdraw', cap the withdraw amount by remaining hint.
        if (task.type === 'withdraw' && hintNow !== null) {
            const free = creep.store.getFreeCapacity(resourceType) || 0;
            const carried = creep.store.getUsedCapacity(resourceType) || 0;
            const amt = capByHintRemaining(hintNow, carried, free);
            if (amt === 0) {
                log(`hint exhausted during gather, force deliver`);
                creep.memory.taskState = 'working';
                resetPressure();
                return execTransferTask(ctx);
            }
            task.amount = amt;
        }
        
        // If withdraw and we computed a cap, task.amount may be set below; log shows both.
        const carriedNow = creep.store.getUsedCapacity(resourceType) || 0;
        const freeNow = creep.store.getFreeCapacity(resourceType) || 0;
        log(`gather task ${fmtTask(task)} carried=${carriedNow} free=${freeNow} hint=${fmtN(hintNow)}`);
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
