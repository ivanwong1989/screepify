const trafficAdapter = require('traffic_trafficAdapter');

const TRAFFIC_STALE_REPATH_TICKS = 3;
const TRAFFIC_MOVE_IDLE_CLEAR_TICKS = 2;
const PACK64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const PACK64_BASE = PACK64_ALPHABET.length;

function toTargetPos(target) {
    if (!target) return null;
    if (target.pos) return target.pos;
    if (Number.isFinite(target.x) && Number.isFinite(target.y) && target.roomName) return target;
    return null;
}

function buildTargetKey(targetPos, range, maxRooms) {
    return `${targetPos.roomName}|${targetPos.x.toString(36)}|${targetPos.y.toString(36)}|${range.toString(36)}|${maxRooms.toString(36)}`;
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

function packCoord(x, y) {
    if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
    if (x < 0 || x > 49 || y < 0 || y > 49) return null;
    const value = (y * 50) + x;
    const hi = Math.floor(value / PACK64_BASE);
    const lo = value % PACK64_BASE;
    return PACK64_ALPHABET.charAt(hi) + PACK64_ALPHABET.charAt(lo);
}

function unpackCoord(packed, index) {
    const charIndex = index * 2;
    if (typeof packed !== 'string' || charIndex < 0 || (charIndex + 1) >= packed.length) return null;
    const hi = PACK64_ALPHABET.indexOf(packed.charAt(charIndex));
    const lo = PACK64_ALPHABET.indexOf(packed.charAt(charIndex + 1));
    if (hi < 0 || lo < 0) return null;
    const value = (hi * PACK64_BASE) + lo;
    const x = value % 50;
    const y = Math.floor(value / 50);
    if (x < 0 || x > 49 || y < 0 || y > 49) return null;
    return { x, y };
}

function packPath(path) {
    if (!Array.isArray(path) || path.length <= 0) return '';
    let out = '';
    for (let i = 0; i < path.length; i++) {
        const step = path[i];
        if (!step) continue;
        const packed = packCoord(step.x, step.y);
        if (!packed) continue;
        out += packed;
    }
    return out;
}

function pathLength(mem) {
    if (!mem) return 0;
    if (Number.isFinite(mem.l) && mem.l > 0) return mem.l;
    if (typeof mem.p === 'string') return Math.floor(mem.p.length / 2);
    if (Array.isArray(mem.path)) return mem.path.length;
    return 0;
}

function getPathStep(mem, index) {
    if (!mem || !Number.isInteger(index) || index < 0) return null;
    if (typeof mem.p === 'string') {
        const coord = unpackCoord(mem.p, index);
        if (!coord) return null;
        return {
            x: coord.x,
            y: coord.y,
            roomName: mem.roomName
        };
    }
    if (!Array.isArray(mem.path) || index >= mem.path.length) return null;
    return mem.path[index];
}

function compactLegacyPath(mem, roomName) {
    if (!mem || typeof mem !== 'object') return;
    if (typeof mem.p === 'string') return;
    if (!Array.isArray(mem.path) || mem.path.length <= 0) return;
    const packed = packPath(mem.path);
    if (!packed || packed.length <= 0) return;
    mem.p = packed;
    mem.roomName = mem.roomName || roomName;
    mem.l = Math.floor(packed.length / 2);
    delete mem.path;
}

function clearMoveMem(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory._trafficMove;
}

function cleanupIdleMoveMem(creep) {
    if (!creep || !creep.memory || !creep.memory._trafficMove) return;
    const mem = creep.memory._trafficMove;
    const lastPlan = Number.isFinite(mem.lastPlan) ? mem.lastPlan : mem.lastCalc;
    if (!Number.isFinite(lastPlan)) return;
    if ((Game.time - lastPlan) <= TRAFFIC_MOVE_IDLE_CLEAR_TICKS) return;
    clearMoveMem(creep);
}

function reconcileTrafficMoveProgress(creep) {
    if (!creep || !creep.memory || !creep.memory._trafficMove) return;
    const mem = creep.memory._trafficMove;
    compactLegacyPath(mem, creep.room.name);

    const len = pathLength(mem);
    if (len <= 0) {
        clearMoveMem(creep);
        return;
    }

    if (!Number.isInteger(mem.idx) || mem.idx < 0) mem.idx = 0;

    while (mem.idx < len && samePos(creep.pos, getPathStep(mem, mem.idx))) {
        mem.idx++;
    }

    if (mem.idx >= len) {
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
    compactLegacyPath(mem, creep.room.name);
    if (!mem) return true;
    const len = pathLength(mem);
    if (len <= 0) return true;
    if (mem.targetKey !== targetKey) return true;
    if (mem.range !== range) return true;
    if (mem.maxRooms !== maxRooms) return true;
    if (mem.roomName !== creep.room.name) return true;
    if (!Number.isInteger(mem.idx)) return true;
    if (mem.idx < 0 || mem.idx > len) return true;
    if (mem.forceRepath) return true;
    if ((mem.stale || 0) >= TRAFFIC_STALE_REPATH_TICKS) return true;

    if (mem.idx > 0) {
        const prev = getPathStep(mem, mem.idx - 1);
        const current = getPathStep(mem, mem.idx);
        if (!prev || !current) return true;
        if (!samePos(creep.pos, prev) && !samePos(creep.pos, current)) {
            return true;
        }
    }

    if (targetPos.roomName !== creep.room.name && maxRooms <= 1) return true;

    return false;
}

function repath(creep, mem, targetPos, range, maxRooms, targetKey) {
    const stale = mem && Number.isFinite(mem.stale) ? mem.stale : 0;
    const avoidCreeps = stale >= TRAFFIC_STALE_REPATH_TICKS;
    let path = creep.pos.findPathTo(targetPos, {
        range,
        ignoreCreeps: !avoidCreeps,
        maxRooms,
        reusePath: 0
    });
    // If dynamic-avoid path search fails, retry permissive so movement can still make progress.
    if ((!Array.isArray(path) || path.length <= 0) && avoidCreeps) {
        path = creep.pos.findPathTo(targetPos, {
            range,
            ignoreCreeps: true,
            maxRooms,
            reusePath: 0
        });
    }

    if (!Array.isArray(path) || path.length <= 0) {
        if (creep.pos.inRangeTo(targetPos, range)) {
            clearMoveMem(creep);
            return OK;
        }
        clearMoveMem(creep);
        return ERR_NO_PATH;
    }

    const packedPath = packPath(path);
    if (!packedPath || packedPath.length <= 0) {
        clearMoveMem(creep);
        return ERR_NO_PATH;
    }

    mem.targetKey = targetKey;
    mem.range = range;
    mem.maxRooms = maxRooms;
    mem.p = packedPath;
    mem.l = Math.floor(packedPath.length / 2);
    delete mem.path;
    mem.idx = 0;
    mem.stale = 0;
    mem.forceRepath = false;
    mem.lastCalc = Game.time;
    mem.lastPlan = Game.time;
    mem.lastPosKey = `${creep.pos.roomName}:${creep.pos.x}:${creep.pos.y}`;
    mem.roomName = creep.room.name;
    mem.lastRepathAvoidCreeps = avoidCreeps ? 1 : 0;

    return OK;
}

function enableTrafficForCoreLaneHauler(creep) {
    cleanupIdleMoveMem(creep);
    trafficAdapter.enableForCreep(creep, {
        blockerMovable: true,
        strict: true
    });
}

function enableTrafficForBuildWorker(creep) {
    cleanupIdleMoveMem(creep);
    trafficAdapter.enableForCreep(creep, {
        blockerMovable: true,
        strict: false
    });
}

function enableTrafficBlockerOnly(creep, opts) {
    if (!creep) return;
    cleanupIdleMoveMem(creep);
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
    cleanupIdleMoveMem(creep);
    return trafficAdapter.registerMove(creep, dir);
}

function planLaneStep(creep, nextPos) {
    if (!creep) return ERR_INVALID_ARGS;
    if (!nextPos) return ERR_NO_PATH;
    cleanupIdleMoveMem(creep);
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
        if (Memory.debugTraffic && typeof debug === 'function') {
            debug(
                'traffic',
                `[TrafficPlan] moveTo creep=${creep.name} target=${targetPos.roomName}:${targetPos.x},${targetPos.y} range=${range} action=already_in_range`
            );
        }
        return OK;
    }

    const targetKey = buildTargetKey(targetPos, range, maxRooms);
    const mem = ensureMoveMem(creep);
    mem.lastPlan = Game.time;
    compactLegacyPath(mem, creep.room.name);

    reconcileTrafficMoveProgress(creep);

    if (!creep.memory._trafficMove) {
        const newMem = ensureMoveMem(creep);
        const repathCode = repath(creep, newMem, targetPos, range, maxRooms, targetKey);
        if (Memory.debugTraffic && typeof debug === 'function') {
            debug(
                'traffic',
                `[TrafficPlan] repath creep=${creep.name} mode=init code=${repathCode} target=${targetPos.roomName}:${targetPos.x},${targetPos.y} range=${range}`
            );
        }
        if (repathCode !== OK) return repathCode;
    } else if (shouldRepath(creep, mem, targetPos, range, maxRooms, targetKey)) {
        const repathCode = repath(creep, mem, targetPos, range, maxRooms, targetKey);
        if (Memory.debugTraffic && typeof debug === 'function') {
            debug(
                'traffic',
                `[TrafficPlan] repath creep=${creep.name} mode=refresh code=${repathCode} stale=${mem ? (mem.stale || 0) : 0} idx=${mem && Number.isInteger(mem.idx) ? mem.idx : '-'} target=${targetPos.roomName}:${targetPos.x},${targetPos.y}`
            );
        }
        if (repathCode !== OK) return repathCode;
    }

    reconcileTrafficMoveProgress(creep);
    const activeMem = creep.memory._trafficMove;
    if (!activeMem) return OK;
    activeMem.lastPlan = Game.time;
    compactLegacyPath(activeMem, creep.room.name);
    const len = pathLength(activeMem);
    if (len <= 0) return OK;

    if (!Number.isInteger(activeMem.idx) || activeMem.idx < 0) activeMem.idx = 0;
    if (activeMem.idx >= len) {
        clearMoveMem(creep);
        return OK;
    }

    const next = getPathStep(activeMem, activeMem.idx);
    if (!next) return ERR_NO_PATH;

    if (Memory.debugTraffic && typeof debug === 'function') {
        debug(
            'traffic',
            `[TrafficPlan] moveTo creep=${creep.name} target=${targetPos.x},${targetPos.y} ` +
            `range=${range} idx=${activeMem.idx}/${len} next=${next.x},${next.y}`
        );
    }

    const code = trafficAdapter.registerMove(creep, new RoomPosition(next.x, next.y, next.roomName));
    if (Memory.debugTraffic && typeof debug === 'function') {
        debug(
            'traffic',
            `[TrafficPlan] register creep=${creep.name} code=${code} next=${next.roomName}:${next.x},${next.y} idx=${activeMem.idx}/${len}`
        );
    }

    return code;
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
