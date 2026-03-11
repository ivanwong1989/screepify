const heap = require('utils_heap');

let _laneRuntimeTick = -1;
let _laneRuntime = Object.create(null);
let _laneRuntimeLastPrune = -1;

function posKey(pos) {
    if (!pos) return '';
    return `${pos.roomName}:${pos.x},${pos.y}`;
}

function getLaneRuntime(lane, laneKey, homeRoomName) {
    if (!lane || !laneKey || !homeRoomName) return null;
    if (_laneRuntimeTick !== Game.time) {
        _laneRuntimeTick = Game.time;
    }
    if (_laneRuntimeLastPrune !== Game.time && (Game.time % 101) === 0) {
        _laneRuntimeLastPrune = Game.time;
        const keys = Object.keys(_laneRuntime);
        if (keys.length > 500) {
            _laneRuntime = Object.create(null);
        }
    }

    const cacheKey = `${homeRoomName}:${laneKey}`;
    const cached = _laneRuntime[cacheKey];
    const laneStamp = `${lane.t || 0}:${lane.sig || ''}:${Array.isArray(lane.p) ? lane.p.length : 0}:${lane.s || ''}`;
    if (cached && cached.stamp === laneStamp) return cached;

    let path = null;
    if (Array.isArray(lane.p) && lane.p.length) {
        try {
            path = lane.p.map(pt => new RoomPosition(pt.x, pt.y, pt.r || pt.roomName));
        } catch (e) {
            path = null;
        }
    } else if (lane.s) {
        try {
            path = Room.deserializePath(lane.s);
        } catch (e) {
            path = null;
        }
    }

    if (!Array.isArray(path) || path.length === 0) {
        _laneRuntime[cacheKey] = { stamp: laneStamp, path: null, indexByPos: null };
        return _laneRuntime[cacheKey];
    }

    const indexByPos = Object.create(null);
    for (let i = 0; i < path.length; i++) {
        const k = posKey(path[i]);
        if (!k || indexByPos[k] !== undefined) continue;
        indexByPos[k] = i;
    }

    const built = { stamp: laneStamp, path, indexByPos };
    _laneRuntime[cacheKey] = built;
    return built;
}

function getHeapLane(homeRoomName, laneKey) {
    if (!homeRoomName || !laneKey) return null;

    let store;
    try {
        store = heap && heap.getStore ? heap.getStore('remoteHaul') : null;
    } catch (e) {
        store = null;
    }
    if (!store || !store.rooms) return null;

    const roomCache = store.rooms[homeRoomName];
    if (!roomCache || !roomCache.lanes) return null;

    return roomCache.lanes[laneKey] || null;
}

function getOwnedLane(laneKey, homeRoomName) {
    if (!laneKey || !homeRoomName) return null;
    return getHeapLane(homeRoomName, laneKey);
}

function isWalkableForCreep(room, x, y) {
    if (!room || x < 0 || x > 49 || y < 0 || y > 49) return false;
    const terrain = room.getTerrain().get(x, y);
    if (terrain === TERRAIN_MASK_WALL) return false;

    const structures = room.lookForAt(LOOK_STRUCTURES, x, y);
    for (let i = 0; i < structures.length; i++) {
        const s = structures[i];
        if (!s) continue;
        if (s.structureType === STRUCTURE_ROAD) continue;
        if (s.structureType === STRUCTURE_CONTAINER) continue;
        if (s.structureType === STRUCTURE_PORTAL) continue;
        if (s.structureType === STRUCTURE_EXTRACTOR) continue;
        if (s.structureType === STRUCTURE_RAMPART && (s.my || s.isPublic)) continue;
        return false;
    }
    return true;
}

function getPathIndex(path, pos, indexByPos) {
    if (!Array.isArray(path) || !pos) return -1;
    if (indexByPos) {
        const idx = indexByPos[posKey(pos)];
        if (Number.isInteger(idx)) return idx;
    }
    for (let i = 0; i < path.length; i++) {
        const p = path[i];
        if (p && p.roomName === pos.roomName && p.x === pos.x && p.y === pos.y) return i;
    }
    return -1;
}

function getLaneNextPosForCreep(creep) {
    if (!creep || !creep.memory || !creep.memory.task) return null;
    const task = creep.memory.task;
    const meta = task.meta;
    if (!meta || meta.moveMode !== 'lane' || !meta.laneKey || !meta.homeRoom) return null;

    const lane = getOwnedLane(meta.laneKey, meta.homeRoom);
    const runtime = getLaneRuntime(lane, meta.laneKey, meta.homeRoom);
    const path = runtime && runtime.path;
    if (!Array.isArray(path) || path.length === 0) return null;

    const idx = getPathIndex(path, creep.pos, runtime.indexByPos);
    if (idx < 0 || idx + 1 >= path.length) return null;
    return path[idx + 1];
}

function getSingleCreepAt(room, pos, selfId) {
    if (!room || !pos) return null;
    const creeps = room.lookForAt(LOOK_CREEPS, pos.x, pos.y);
    if (!creeps || creeps.length === 0) return null;
    for (let i = 0; i < creeps.length; i++) {
        const c = creeps[i];
        if (c && c.id !== selfId) return c;
    }
    return null;
}

function trySwapWithBlocker(creep, blocker, myNextPos) {
    if (!creep || !blocker || !myNextPos) return false;
    if (creep.fatigue > 0 || blocker.fatigue > 0) return false;
    if (!blocker.my) return false;

    const blockerNext = getLaneNextPosForCreep(blocker);
    if (!blockerNext) return false;
    if (blockerNext.roomName !== creep.pos.roomName || blockerNext.x !== creep.pos.x || blockerNext.y !== creep.pos.y) return false;
    if (myNextPos.roomName !== blocker.pos.roomName || myNextPos.x !== blocker.pos.x || myNextPos.y !== blocker.pos.y) return false;

    const blockerDir = blocker.pos.getDirectionTo(creep.pos);
    const myDir = creep.pos.getDirectionTo(blocker.pos);
    const bCode = blocker.move(blockerDir);
    const mCode = creep.move(myDir);
    return (bCode === OK || bCode === ERR_TIRED) && (mCode === OK || mCode === ERR_TIRED);
}

function tryNudgeBlockerForward(creep, blocker) {
    if (!creep || !blocker || !blocker.my) return false;
    if (creep.fatigue > 0 || blocker.fatigue > 0) return false;

    const blockerNext = getLaneNextPosForCreep(blocker);
    if (!blockerNext || blockerNext.roomName !== blocker.pos.roomName) return false;
    if (!isWalkableForCreep(blocker.room, blockerNext.x, blockerNext.y)) return false;

    const occupant = getSingleCreepAt(blocker.room, blockerNext, blocker.id);
    if (occupant) return false;

    const bDir = blocker.pos.getDirectionTo(blockerNext);
    const bCode = blocker.move(bDir);
    if (bCode !== OK && bCode !== ERR_TIRED) return false;

    const mDir = creep.pos.getDirectionTo(blocker.pos);
    const mCode = creep.move(mDir);
    return mCode === OK || mCode === ERR_TIRED;
}

function tryMoveByLane(creep, lane, destPos, range) {
    if (!creep || !lane) return false;

    const moveRange = Number.isFinite(range) ? range : 1;
    if (destPos && creep.pos.inRangeTo(destPos, moveRange)) return true;
    const isRemoteHauler = creep.memory && creep.memory.role === 'remote_hauler';

    const task = creep.memory && creep.memory.task;
    const meta = task && task.meta;
    const laneKey = meta && meta.laneKey;
    const homeRoom = meta && meta.homeRoom;

    const runtime = getLaneRuntime(lane, laneKey, homeRoom);
    const path = runtime && runtime.path;
    if (!Array.isArray(path) || path.length === 0) return false;
    const isExitTile = (p) => !!p && (p.x === 0 || p.x === 49 || p.y === 0 || p.y === 49);

    const getNearestLaneTile = () => {
        let best = null;
        let bestRange = Infinity;

        for (let i = 0; i < path.length; i++) {
            const p = path[i];
            if (!p || p.roomName !== creep.room.name) continue;
            if (isExitTile(p)) continue;
            const r = creep.pos.getRangeTo(p);
            if (r < bestRange) {
                best = p;
                bestRange = r;
            }
        }

        if (!best) {
            for (let i = 0; i < path.length; i++) {
                const p = path[i];
                if (!p || isExitTile(p)) continue;
                best = p;
                break;
            }
        }
        return best;
    };

    const idx = getPathIndex(path, creep.pos, runtime.indexByPos);
    let debugStore = null;
    if (creep && creep.name) {
        debugStore = heap.getStore('laneDebug');
        if (!debugStore.creeps) debugStore.creeps = Object.create(null);
        if (!debugStore.creeps[creep.name]) debugStore.creeps[creep.name] = Object.create(null);
    }
    if (idx === -1) {
        const nearest = getNearestLaneTile();
        if (!nearest) return false;
        const code = creep.moveTo(nearest, { range: 0, reusePath: 3, ignoreCreeps: false });
        if (debugStore) debugStore.creeps[creep.name].lastMoveByPathCode = code;
        return code === OK || code === ERR_TIRED;
    }

    const nextPos = (idx + 1 < path.length) ? path[idx + 1] : null;
    if (isRemoteHauler && nextPos && nextPos.roomName === creep.room.name) {
        const blocker = getSingleCreepAt(creep.room, nextPos, creep.id);
        if (blocker) {
            if (trySwapWithBlocker(creep, blocker, nextPos)) return true;
            if (tryNudgeBlockerForward(creep, blocker)) return true;
        }
    }

    const code = creep.moveByPath(path);
    if (debugStore) debugStore.creeps[creep.name].lastMoveByPathCode = code;
    if (code === OK || code === ERR_TIRED) return true;
    // On-lane creeps should not pathfind around the train; hold lane discipline.
    return false;
}

module.exports = {
    getOwnedLane,
    tryMoveByLane,
};
