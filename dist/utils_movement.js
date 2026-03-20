const trafficAdapter = require('traffic_trafficAdapter');

const TRAFFIC_STALE_REPATH_TICKS = 3;

function toTargetPos(target) {
    if (!target) return null;
    if (target.pos) return target.pos;
    if (Number.isFinite(target.x) && Number.isFinite(target.y) && target.roomName) return target;
    return null;
}

function buildTargetKey(targetPos, range, maxRooms) {
    return `${targetPos.roomName}:${targetPos.x}:${targetPos.y}:r${range}:m${maxRooms}`;
}

function samePos(pos, step) {
    if (!pos || !step) return false;
    if (step.roomName && pos.roomName !== step.roomName) return false;
    return pos.x === step.x && pos.y === step.y;
}

function ensureMoveMem(creep) {
    if (!creep.memory._trafficMove || typeof creep.memory._trafficMove !== 'object') {
        creep.memory._trafficMove = {};
    }
    return creep.memory._trafficMove;
}

function clearMoveMem(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory._trafficMove;
}

function reconcileTrafficMoveProgress(creep) {
    if (!creep || !creep.memory || !creep.memory._trafficMove) return;
    const mem = creep.memory._trafficMove;

    if (!Array.isArray(mem.path) || mem.path.length <= 0) {
        clearMoveMem(creep);
        return;
    }

    if (!Number.isInteger(mem.idx) || mem.idx < 0) mem.idx = 0;

    while (mem.idx < mem.path.length && samePos(creep.pos, mem.path[mem.idx])) {
        mem.idx++;
    }

    if (mem.idx >= mem.path.length) {
        clearMoveMem(creep);
        return;
    }

    const posKey = `${creep.pos.roomName}:${creep.pos.x}:${creep.pos.y}`;
    if (mem.lastPosKey === posKey) {
        mem.stale = (mem.stale || 0) + 1;
    } else {
        mem.stale = 0;
    }
    mem.lastPosKey = posKey;
}

function shouldRepath(creep, mem, targetPos, range, maxRooms, targetKey) {
    if (!mem || !Array.isArray(mem.path)) return true;
    if (mem.path.length <= 0) return true;
    if (mem.targetKey !== targetKey) return true;
    if (mem.range !== range) return true;
    if (mem.maxRooms !== maxRooms) return true;
    if (mem.roomName !== creep.room.name) return true;
    if (!Number.isInteger(mem.idx)) return true;
    if (mem.idx < 0 || mem.idx > mem.path.length) return true;
    if (mem.forceRepath) return true;
    if ((mem.stale || 0) >= TRAFFIC_STALE_REPATH_TICKS) return true;

    for (let i = 0; i < mem.path.length; i++) {
        const step = mem.path[i];
        if (!step || step.roomName !== creep.room.name) return true;
    }

    if (mem.idx > 0) {
        const prev = mem.path[mem.idx - 1];
        const current = mem.path[mem.idx];
        if (!samePos(creep.pos, prev) && !samePos(creep.pos, current)) {
            return true;
        }
    }

    if (targetPos.roomName !== creep.room.name && maxRooms <= 1) return true;

    return false;
}

function repath(creep, mem, targetPos, range, maxRooms, targetKey) {
    const path = creep.pos.findPathTo(targetPos, {
        range,
        ignoreCreeps: true,
        maxRooms,
        reusePath: 0
    });

    if (!Array.isArray(path) || path.length <= 0) {
        if (creep.pos.inRangeTo(targetPos, range)) {
            clearMoveMem(creep);
            return OK;
        }
        return ERR_NO_PATH;
    }

    const normalizedPath = [];
    for (let i = 0; i < path.length; i++) {
        const step = path[i];
        if (!step) continue;
        normalizedPath.push({
            x: step.x,
            y: step.y,
            roomName: creep.room.name
        });
    }

    if (normalizedPath.length <= 0) return ERR_NO_PATH;

    mem.targetKey = targetKey;
    mem.range = range;
    mem.maxRooms = maxRooms;
    mem.path = normalizedPath;
    mem.idx = 0;
    mem.stale = 0;
    mem.forceRepath = false;
    mem.lastCalc = Game.time;
    mem.lastPosKey = `${creep.pos.roomName}:${creep.pos.x}:${creep.pos.y}`;
    mem.roomName = creep.room.name;

    return OK;
}

function enableTrafficForCoreLaneHauler(creep) {
    trafficAdapter.enableForCreep(creep, {
        blockerMovable: true,
        strict: true
    });
}

function enableTrafficForBuildWorker(creep) {
    trafficAdapter.enableForCreep(creep, {
        blockerMovable: true,
        strict: false
    });
}

function enableTrafficBlockerOnly(creep, opts) {
    if (!creep) return;
    const options = opts || {};
    trafficAdapter.enableForCreep(creep, {
        managed: false,
        blockerMovable: true,
        strict: false
    });
    if (options.anchorPos) {
        const range = Number.isFinite(options.range) ? Math.max(0, options.range) : 1;
        trafficAdapter.setWorkingArea(creep, options.anchorPos, range);
    }
}

function planMove(creep, dir) {
    if (!creep || !Number.isInteger(dir)) return ERR_INVALID_ARGS;
    return trafficAdapter.registerMove(creep, dir);
}

function planLaneStep(creep, nextPos) {
    if (!creep) return ERR_INVALID_ARGS;
    if (!nextPos) return ERR_NO_PATH;
    if (Memory.debugTraffic && typeof debug === 'function') {
        debug('traffic', `[TrafficPlan] lane creep=${creep.name} next=${nextPos.x},${nextPos.y}`);
    }
    return trafficAdapter.registerMove(creep, nextPos);
}

function planMoveTo(creep, target, opts) {
    if (!creep) return ERR_INVALID_ARGS;

    const targetPos = toTargetPos(target);
    if (!targetPos) return ERR_INVALID_TARGET;

    const options = opts || {};
    const range = Number.isFinite(options.range) ? Math.max(0, options.range) : 1;
    const maxRooms = Number.isFinite(options.maxRooms) ? Math.max(1, options.maxRooms) : 1;

    if (creep.pos.roomName === targetPos.roomName && creep.pos.inRangeTo(targetPos, range)) {
        clearMoveMem(creep);
        return OK;
    }

    const targetKey = buildTargetKey(targetPos, range, maxRooms);
    const mem = ensureMoveMem(creep);

    reconcileTrafficMoveProgress(creep);

    if (!creep.memory._trafficMove) {
        const newMem = ensureMoveMem(creep);
        const repathCode = repath(creep, newMem, targetPos, range, maxRooms, targetKey);
        if (repathCode !== OK) return repathCode;
    } else if (shouldRepath(creep, mem, targetPos, range, maxRooms, targetKey)) {
        const repathCode = repath(creep, mem, targetPos, range, maxRooms, targetKey);
        if (repathCode !== OK) return repathCode;
    }

    reconcileTrafficMoveProgress(creep);
    const activeMem = creep.memory._trafficMove;
    if (!activeMem || !Array.isArray(activeMem.path)) return OK;

    if (!Number.isInteger(activeMem.idx) || activeMem.idx < 0) activeMem.idx = 0;
    if (activeMem.idx >= activeMem.path.length) {
        clearMoveMem(creep);
        return OK;
    }

    const next = activeMem.path[activeMem.idx];
    if (!next) return ERR_NO_PATH;

    if (Memory.debugTraffic && typeof debug === 'function') {
        debug(
            'traffic',
            `[TrafficPlan] moveTo creep=${creep.name} target=${targetPos.x},${targetPos.y} ` +
            `range=${range} idx=${activeMem.idx}/${activeMem.path.length} next=${next.x},${next.y}`
        );
    }

    return trafficAdapter.registerMove(creep, new RoomPosition(next.x, next.y, next.roomName));
}

function finalizeRoomTraffic(room, costs) {
    trafficAdapter.finalizeRoom(room, costs);
}

module.exports = {
    enableTrafficForBuildWorker,
    enableTrafficForCoreLaneHauler,
    enableTrafficBlockerOnly,
    planMove,
    planMoveTo,
    planLaneStep,
    finalizeRoomTraffic,
    reconcileTrafficMoveProgress
};
