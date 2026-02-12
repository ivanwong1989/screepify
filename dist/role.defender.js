/**
 * Dedicated combat role for defenders.
 * Handles tactical movement and combat actions.
 */
function moveToTarget(creep, target, range, visualizePathStyle) {
    const moveRange = Number.isFinite(range) ? range : 1;
    const opts = { range: moveRange };
    if (visualizePathStyle) opts.visualizePathStyle = visualizePathStyle;
    creep.moveTo(target, opts);
}

var roleDefender = {
    /** @param {Creep} creep **/
    run: function(creep) {
        const task = creep.memory.task;
        const debugCombat = Memory.debugCombat;
        
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
