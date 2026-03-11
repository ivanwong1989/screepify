const heap = require('utils_heap');
const helpers = require('managers_overseer_tasks_exec__helpers');
const remoteUtils = require('managers_overseer_utils_overseer.remote');

module.exports = function execRemoteHaulTask(ctx) {
    const { creep, mission } = ctx;
    const data = mission.data || {};
    const resourceType = data.resourceType || RESOURCE_ENERGY;
    const pickupPos = helpers.toRoomPosition(data.pickupPos);
    const dropoffPos = helpers.toRoomPosition(data.dropoffPos);
    const pickupMode = data.pickupMode || 'container';
    const pickupRange = Number.isFinite(data.pickupRange) ? data.pickupRange : 1;
    const remoteRoom = data.remoteRoom || (pickupPos && pickupPos.roomName);

    // NEW: lane metadata (consumed by role.universal later)
    const laneKeyToPickup = data.laneKeyToPickup || data.laneKey || null;
    const laneKeyToDropoff = data.laneKeyToDropoff || data.laneKey || null;
    const homeRoom = data.homeRoom || creep.memory.room || null;

    // Runtime threat feed: haulers with vision in remote room can refresh hostile gate intel.
    if (remoteRoom && homeRoom && creep.room && creep.room.name === remoteRoom) {
        remoteUtils.recordRuntimeThreatIntel(homeRoom, creep.room);
    }

    const moveMeta = (extra) => {
        const dir = extra && extra.dir;
        const chosenLaneKey = (dir === 'toDropoff') ? laneKeyToDropoff : laneKeyToPickup;

        // If laneKey/homeRoom missing, still return meta (but universal can ignore).
        return Object.assign({
            moveMode: 'lane',
            laneKey: chosenLaneKey,
            homeRoom: homeRoom
        }, extra || {});
    };

    const log = (msg) => debug('mission.remote.haul', `[RemoteHaulTask] ${creep.name} ${msg}`);
    // Volatile per-creep runtime state (avoid writing to Memory).
    // If heap resets, state is rebuilt automatically and only affects logs.
    let st;
    const store = heap.getStore('remoteHaul');
    store.creeps = store.creeps || {};
    st = store.creeps[creep.name] || (store.creeps[creep.name] = {});
    const logOnce = (sig, msg) => {
        if (st._lastLogSig === sig) return;
        st._lastLogSig = sig;
        log(msg);
    };
    const tryOpportunisticPickup = () => {
        if (creep.store.getFreeCapacity(resourceType) <= 0) return null;

        const dropped = creep.room.lookForAt(LOOK_RESOURCES, creep.pos.x, creep.pos.y);
        if (dropped && dropped.length > 0) {
            let target = null;
            let best = 0;
            for (let i = 0; i < dropped.length; i++) {
                const r = dropped[i];
                if (!r || r.resourceType !== resourceType || (r.amount || 0) <= 0) continue;
                if (r.amount > best) {
                    best = r.amount;
                    target = r;
                }
            }
            if (target) {
                logOnce(`pickup:lane:${target.id}`, `pickup lane -> ${target.id} res=${resourceType}`);
                return { type: 'pickup', targetId: target.id };
            }
        }

        const tombstones = creep.room.lookForAt(LOOK_TOMBSTONES, creep.pos.x, creep.pos.y);
        if (tombstones && tombstones.length > 0) {
            let target = null;
            let best = 0;
            for (let i = 0; i < tombstones.length; i++) {
                const t = tombstones[i];
                const amt = (t && t.store && t.store[resourceType]) || 0;
                if (amt > best) {
                    best = amt;
                    target = t;
                }
            }
            if (target) {
                logOnce(`withdraw:tomb:lane:${target.id}`, `withdraw lane tombstone -> ${target.id} res=${resourceType}`);
                return { type: 'withdraw', targetId: target.id, resourceType: resourceType };
            }
        }

        const ruins = creep.room.lookForAt(LOOK_RUINS, creep.pos.x, creep.pos.y);
        if (ruins && ruins.length > 0) {
            let target = null;
            let best = 0;
            for (let i = 0; i < ruins.length; i++) {
                const r = ruins[i];
                const amt = (r && r.store && r.store[resourceType]) || 0;
                if (amt > best) {
                    best = amt;
                    target = r;
                }
            }
            if (target) {
                logOnce(`withdraw:ruin:lane:${target.id}`, `withdraw lane ruin -> ${target.id} res=${resourceType}`);
                return { type: 'withdraw', targetId: target.id, resourceType: resourceType };
            }
        }

        return null;
    };

    helpers.updateState(creep, resourceType, { requireFull: true });

    if (st._lastTaskState !== creep.memory.taskState) {
        st._lastTaskState = creep.memory.taskState;
        logOnce(`state:${st._lastTaskState}`, `state=${st._lastTaskState} res=${resourceType}`);
    }

    if (creep.memory.taskState === 'working') {
        const opportunistic = tryOpportunisticPickup();
        if (opportunistic) return opportunistic;

        const dropoffMoveRange = 1;
        if (dropoffPos && !creep.pos.inRangeTo(dropoffPos, dropoffMoveRange)) {
            logOnce(
                `move:dropoff:${dropoffPos.roomName}`,
                `move->dropoff ${dropoffPos.roomName} lane=${laneKeyToDropoff || '-'}`
            );
            return {
                type: 'move',
                targetPos: { x: dropoffPos.x, y: dropoffPos.y, roomName: dropoffPos.roomName },
                range: dropoffMoveRange,
                meta: moveMeta({ dir: 'toDropoff' })
            };
        }

        let target = data.dropoffId ? Game.getObjectById(data.dropoffId) : null;
        if (!target) {
            const cache = global.getRoomCache(creep.room);
            const storage = (cache.myStructuresByType[STRUCTURE_STORAGE] || [])[0];
            if (storage) target = storage;
            if (!target) {
                const spawns = cache.myStructuresByType[STRUCTURE_SPAWN] || [];
                target = creep.pos.findClosestByRange(spawns);
            }
        }

        if (target) {
            if (target.store && target.store.getFreeCapacity(resourceType) === 0) {
                logOnce(`dropoff-full:${target.id}`, `dropoff full target=${target.id}`);
                return { type: 'move', targetId: target.id, range: 1, meta: moveMeta({ dir: 'toDropoff' }) };
            }
            logOnce(`transfer:${target.id}`, `transfer -> ${target.id} res=${resourceType}`);
            return { type: 'transfer', targetId: target.id, resourceType: resourceType };
        }
        logOnce('no-dropoff', 'no dropoff target');
        return null;
    }

    const opportunistic = tryOpportunisticPickup();
    if (opportunistic) return opportunistic;

    if (pickupPos && !creep.pos.inRangeTo(pickupPos, pickupRange)) {
        logOnce(
            `move:pickup:${pickupPos.roomName}`,
            `move->pickup ${pickupPos.roomName} lane=${laneKeyToPickup || '-'} mode=${pickupMode}`
        );
        return {
            type: 'move',
            targetPos: { x: pickupPos.x, y: pickupPos.y, roomName: pickupPos.roomName },
            range: pickupRange,
            meta: moveMeta({ dir: 'toPickup' })
        };
    }

    const pickup = data.pickupId ? Game.getObjectById(data.pickupId) : null;
    if (pickup && pickup.store && (pickup.store[resourceType] || 0) > 0) {
        logOnce(`withdraw:${pickup.id}`, `withdraw -> ${pickup.id} res=${resourceType}`);
        return { type: 'withdraw', targetId: pickup.id, resourceType: resourceType };
    }

    const inPickupArea = (pos) => {
        if (!pos) return false;
        if (!pickupPos) return true;
        return pos.inRangeTo(pickupPos, pickupRange);
    };

    const cache = global.getRoomCache(creep.room);
    const tombstone = creep.pos.findClosestByRange(cache.tombstones || [], {
        filter: t => t.store && (t.store[resourceType] || 0) > 50 && inPickupArea(t.pos)
    });
    if (tombstone) {
        logOnce(`withdraw:tomb:${tombstone.id}`, `withdraw tombstone -> ${tombstone.id} res=${resourceType}`);
        return { type: 'withdraw', targetId: tombstone.id, resourceType: resourceType };
    }

    const dropped = creep.pos.findClosestByRange(cache.dropped || [], {
        filter: r => {
            if (r.resourceType !== resourceType || r.amount <= 50) return false;
            return inPickupArea(r.pos);
        }
    });
    if (dropped) {
        logOnce(`pickup:${dropped.id}`, `pickup -> ${dropped.id} res=${resourceType}`);
        return { type: 'pickup', targetId: dropped.id };
    }

    if (pickupMode === 'drop' && pickupPos) {
        logOnce(
            `wait:pickup:${pickupPos.roomName}`,
            `wait pickup range=${pickupRange} pos=${pickupPos.roomName}:${pickupPos.x},${pickupPos.y}`
        );
        return {
            type: 'move',
            targetPos: { x: pickupPos.x, y: pickupPos.y, roomName: pickupPos.roomName },
            range: pickupRange,
            meta: moveMeta({ dir: 'toPickup' })
        };
    }

    logOnce('no-task', `no task mode=${pickupMode} res=${resourceType}`);
    return null;
};
