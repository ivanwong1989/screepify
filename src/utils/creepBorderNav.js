function getBorderDirection(pos) {
    if (!pos) return null;
    if (pos.x === 0) return FIND_EXIT_LEFT;
    if (pos.x === 49) return FIND_EXIT_RIGHT;
    if (pos.y === 0) return FIND_EXIT_TOP;
    if (pos.y === 49) return FIND_EXIT_BOTTOM;
    return null;
}

function isNudgePositionOpen(room, x, y) {
    if (!room) return false;
    const terrain = room.getTerrain().get(x, y);
    if (terrain === TERRAIN_MASK_WALL) return false;
    const creeps = room.lookForAt(LOOK_CREEPS, x, y);
    if (creeps && creeps.length > 0) return false;
    return true;
}

function getNudgeCandidates(pos) {
    if (!pos) return [];
    const candidates = [];
    const seen = new Set();
    const add = (x, y) => {
        if (x < 1 || x > 48 || y < 1 || y > 48) return;
        const key = (x * 50) + y;
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push(new RoomPosition(x, y, pos.roomName));
    };

    if (pos.x === 0) {
        add(1, pos.y);
        add(1, pos.y - 1);
        add(1, pos.y + 1);
        add(2, pos.y);
        add(2, pos.y - 1);
        add(2, pos.y + 1);
    } else if (pos.x === 49) {
        add(48, pos.y);
        add(48, pos.y - 1);
        add(48, pos.y + 1);
        add(47, pos.y);
        add(47, pos.y - 1);
        add(47, pos.y + 1);
    }

    if (pos.y === 0) {
        add(pos.x, 1);
        add(pos.x - 1, 1);
        add(pos.x + 1, 1);
        add(pos.x, 2);
        add(pos.x - 1, 2);
        add(pos.x + 1, 2);
    } else if (pos.y === 49) {
        add(pos.x, 48);
        add(pos.x - 1, 48);
        add(pos.x + 1, 48);
        add(pos.x, 47);
        add(pos.x - 1, 47);
        add(pos.x + 1, 47);
    }

    return candidates;
}

function getNudgePosition(creep) {
    if (!creep) return null;
    const candidates = getNudgeCandidates(creep.pos);
    for (const pos of candidates) {
        if (isNudgePositionOpen(creep.room, pos.x, pos.y)) return pos;
    }
    return null;
}

function getHomeSpawnTarget(creep) {
    if (!creep || !creep.memory || !creep.memory.room) return null;
    const homeRoom = Game.rooms[creep.memory.room];
    if (!homeRoom) return null;
    let spawns;
    if (global.getRoomCache) {
        const cache = global.getRoomCache(homeRoom);
        spawns = cache && cache.myStructuresByType && cache.myStructuresByType[STRUCTURE_SPAWN];
    }
    if (!spawns || spawns.length === 0) {
        spawns = homeRoom.find(FIND_MY_SPAWNS);
    }
    if (!spawns || spawns.length === 0) return null;
    return spawns[0];
}

function handleBorderNudgeTick(creep) {
    const lastRoom = creep.memory._lastRoom;
    if (lastRoom && lastRoom !== creep.room.name) {
        creep.memory._justEnteredRoom = Game.time;
        creep.memory._borderNudge = true;
    }
    creep.memory._lastRoom = creep.room.name;

    if (!getBorderDirection(creep.pos) && creep.memory._borderNudge) {
        delete creep.memory._borderNudge;
    }

    if (creep.memory._borderNudge && getBorderDirection(creep.pos)) {
        const nudgePos = getNudgePosition(creep);
        if (nudgePos) {
            creep.moveTo(nudgePos, { range: 0, reusePath: 0 });
            return true;
        }
    }
    return false;
}

function moveToTarget(creep, target, range) {
    const moveRange = Number.isFinite(range) ? range : 1;
    const targetPos = target && target.pos ? target.pos : target;
    const borderDir = getBorderDirection(creep.pos);
    const nudgeRequired = borderDir && creep.memory && (creep.memory._borderNudge || creep.memory._justEnteredRoom === Game.time);

    if (nudgeRequired) {
        const nudgePos = getNudgePosition(creep);
        if (nudgePos) {
            creep.moveTo(nudgePos, { range: 0, reusePath: 0 });
            return;
        }
    }

    if (targetPos && targetPos.roomName && targetPos.roomName !== creep.room.name) {
        if (borderDir) {
            const exitDir = creep.room.findExitTo(targetPos.roomName);
            if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS && exitDir !== borderDir) {
                const nudgePos = getNudgePosition(creep);
                if (nudgePos) {
                    creep.moveTo(nudgePos, { range: 0, reusePath: 0 });
                    return;
                }
            }
        }
    }

    creep.moveTo(target, { range: moveRange, reusePath: 20 });
}

module.exports = {
    getHomeSpawnTarget,
    handleBorderNudgeTick,
    moveToTarget,
};
