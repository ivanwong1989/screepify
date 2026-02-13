/**
 * Dedicated combat role for defenders.
 * Handles tactical movement and combat actions.
 */
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

function moveToTarget(creep, target, range, visualizePathStyle) {
    const moveRange = Number.isFinite(range) ? range : 1;
    const targetPos = target && target.pos ? target.pos : target;
    const borderDir = getBorderDirection(creep.pos);
    const nudgeRequired = borderDir && creep.memory && (creep.memory._borderNudge || creep.memory._justEnteredRoom === Game.time);

    if (nudgeRequired) {
        const nudgePos = getOffExitPosition(creep.pos);
        if (nudgePos) {
            const nudgeOpts = { range: 0, reusePath: 0 };
            if (visualizePathStyle) nudgeOpts.visualizePathStyle = visualizePathStyle;
            creep.moveTo(nudgePos, nudgeOpts);
            return;
        }
    }

    if (targetPos && targetPos.roomName && targetPos.roomName !== creep.room.name) {
        if (borderDir) {
            const exitDir = creep.room.findExitTo(targetPos.roomName);
            if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS && exitDir !== borderDir) {
                const nudgePos = getOffExitPosition(creep.pos);
                if (nudgePos) {
                    const nudgeOpts = { range: 0, reusePath: 0 };
                    if (visualizePathStyle) nudgeOpts.visualizePathStyle = visualizePathStyle;
                    creep.moveTo(nudgePos, nudgeOpts);
                    return;
                }
            }
        }
    }

    const opts = { range: moveRange };
    if (visualizePathStyle) opts.visualizePathStyle = visualizePathStyle;
    creep.moveTo(target, opts);
}

var roleDefender = {
    /** @param {Creep} creep **/
    run: function(creep) {
        const task = creep.memory.task;
        const debugCombat = Memory.debugCombat;
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
                const nudgeOpts = { range: 0, reusePath: 0 };
                creep.moveTo(nudgePos, nudgeOpts);
                return;
            }
        }
        
        if (debugCombat) {
            logCombat(`[Defender] ${creep.name} Tick: ${Game.time} Pos: ${creep.pos} Task: ${JSON.stringify(task)}`);
        }

        if (!task) return;

        // 1. Execute Movement (Basic command)
        if (task.moveTarget) {
            const pos = new RoomPosition(task.moveTarget.x, task.moveTarget.y, task.moveTarget.roomName);
            if (debugCombat) {
                logCombat(`[Defender] ${creep.name} moving to ${pos}`);
            }
            moveToTarget(creep, pos, task.range, { stroke: '#ff0000' });
        } else if (task.action === 'move') {
            // Handle generic move tasks (e.g. Decongest/Parking)
            let target;
            if (task.targetId) target = Game.getObjectById(task.targetId);
            else if (task.targetName) target = Game.flags[task.targetName];

            if (target) {
                moveToTarget(creep, target, task.range, { stroke: '#ffffff' });
            }
        }

        // 2. Execute Actions (Supports multiple actions per tick)
        const actions = task.actions || (task.action ? [{ action: task.action, targetId: task.targetId }] : []);

        actions.forEach(act => {
            if (act.action && act.targetId) {
                const target = Game.getObjectById(act.targetId);
                if (target) {
                    if (debugCombat) {
                        logCombat(`[Defender] ${creep.name} executing ${act.action} on ${target} (Range: ${creep.pos.getRangeTo(target)})`);
                    }
                    switch(act.action) {
                        case 'attack': creep.attack(target); break;
                        case 'rangedAttack': creep.rangedAttack(target); break;
                        case 'heal': creep.heal(target); break;
                        case 'rangedHeal': creep.rangedHeal(target); break;
                    }
                } else if (debugCombat) {
                    logCombat(`[Defender] ${creep.name} target ${act.targetId} missing/invisible`);
                }
            }
        });
    }
};

module.exports = roleDefender;
