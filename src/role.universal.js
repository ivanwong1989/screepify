const scoutUtils = require('managers_overseer_utils_overseer.scout');

function getBorderDirection(pos) {
    if (!pos) return null;
    if (pos.x === 0) return FIND_EXIT_LEFT;
    if (pos.x === 49) return FIND_EXIT_RIGHT;
    if (pos.y === 0) return FIND_EXIT_TOP;
    if (pos.y === 49) return FIND_EXIT_BOTTOM;
    return null;
}

function getOffExitPosition(pos) {
    if (!pos) return null;
    let x = pos.x;
    let y = pos.y;
    if (x === 0) x = 1;
    else if (x === 49) x = 48;
    if (y === 0) y = 1;
    else if (y === 49) y = 48;
    if (x === pos.x && y === pos.y) return null;
    return new RoomPosition(x, y, pos.roomName);
}

function moveToTarget(creep, target, range) {
    const moveRange = Number.isFinite(range) ? range : 1;
    const targetPos = target && target.pos ? target.pos : target;
    const borderDir = getBorderDirection(creep.pos);
    const nudgeRequired = borderDir && creep.memory && (creep.memory._borderNudge || creep.memory._justEnteredRoom === Game.time);

    if (nudgeRequired) {
        const nudgePos = getOffExitPosition(creep.pos);
        if (nudgePos) {
            creep.moveTo(nudgePos, { range: 0, reusePath: 0 });
            return;
        }
    }

    if (targetPos && targetPos.roomName && targetPos.roomName !== creep.room.name) {
        if (borderDir) {
            const exitDir = creep.room.findExitTo(targetPos.roomName);
            if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS && exitDir !== borderDir) {
                const nudgePos = getOffExitPosition(creep.pos);
                if (nudgePos) {
                    creep.moveTo(nudgePos, { range: 0, reusePath: 0 });
                    return;
                }
            }
        }
    }

    creep.moveTo(target, { range: moveRange, reusePath: 20 });
}

var roleUniversal = {
    /**
     * The universal role creep logic.
     * Reads 'task' from memory and executes it.
     * @param {Creep} creep
     */
    run: function(creep) {
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
            const nudgePos = getOffExitPosition(creep.pos);
            if (nudgePos) {
                creep.moveTo(nudgePos, { range: 0, reusePath: 0 });
                return;
            }
        }

        let task = creep.memory.task;

        if (creep.memory.role === 'scout') {
            scoutUtils.ensureScoutTask(creep, task);
            task = creep.memory.task;
            const scoutData = creep.memory.scout || (task && task.scout);
            if (scoutData) scoutUtils.recordRemoteIntel(creep, scoutData);
        }

        if (!task) return;

        let target;
        // Targets can be ID or Names
        if (task.targetId) {
            target = Game.getObjectById(task.targetId);
        } else if (task.targetName) {
            target = Game.flags[task.targetName];
        } else if (task.targetPos) {
            const pos = task.targetPos;
            if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && pos.roomName) {
                target = new RoomPosition(pos.x, pos.y, pos.roomName);
            }
        } else if (task.moveTarget) {
            const pos = task.moveTarget;
            if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && pos.roomName) {
                target = new RoomPosition(pos.x, pos.y, pos.roomName);
            }
        }

        // If the target is no longer valid (despawned, destroyed), clear the task.
        if (!target && task.action !== 'drop') {
            delete creep.memory.task;
            return;
        }

        switch(task.action) {
            case 'move':
                if (target) {
                    const targetPos = target.pos ? target.pos : target;
                    if (!creep.pos.isEqualTo(targetPos)) {
                        moveToTarget(creep, targetPos, task.range);
                    }
                }
                break;
            case 'harvest':
                if (creep.harvest(target) === ERR_NOT_IN_RANGE) {
                    moveToTarget(creep, target, task.range);
                }
                break;
            case 'transfer':
                if (creep.transfer(target, task.resourceType) === ERR_NOT_IN_RANGE) {
                    moveToTarget(creep, target, task.range);
                }
                break;
            case 'withdraw':
                if (creep.withdraw(target, task.resourceType) === ERR_NOT_IN_RANGE) {
                    moveToTarget(creep, target, task.range);
                }
                break;
            case 'pickup':
                if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
                    moveToTarget(creep, target, task.range);
                }
                break;
            case 'upgrade':
                if (creep.upgradeController(target) === ERR_NOT_IN_RANGE) {
                    moveToTarget(creep, target, task.range);
                }
                break;
            case 'build':
                if (creep.build(target) === ERR_NOT_IN_RANGE) {
                    moveToTarget(creep, target, task.range);
                }
                break;
            case 'repair':
                if (creep.repair(target) === ERR_NOT_IN_RANGE) {
                    moveToTarget(creep, target, task.range);
                }
                break;
            case 'dismantle':
                if (creep.dismantle(target) === ERR_NOT_IN_RANGE) {
                    moveToTarget(creep, target, task.range);
                }
                break;
            case 'reserve':
                if (creep.reserveController(target) === ERR_NOT_IN_RANGE) {
                    moveToTarget(creep, target, task.range);
                }
                break;
            case 'drop':
                creep.drop(task.resourceType);
                break;
        }
    }
};

module.exports = roleUniversal;
