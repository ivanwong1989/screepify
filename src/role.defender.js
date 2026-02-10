/**
 * Dedicated combat role for defenders.
 * Handles tactical movement and combat actions.
 */
var roleDefender = {
    /** @param {Creep} creep **/
    run: function(creep) {
        const task = creep.memory.task;
        if (!task) return;

        // 1. Execute Movement (Basic command)
        if (task.moveTarget) {
            const pos = new RoomPosition(task.moveTarget.x, task.moveTarget.y, task.moveTarget.roomName);
            creep.moveTo(pos, { visualizePathStyle: { stroke: '#ff0000' } });
        }

        // 2. Execute Action (Basic command)
        if (task.action && task.targetId) {
            const target = Game.getObjectById(task.targetId);
            if (target) {
                switch(task.action) {
                    case 'attack': creep.attack(target); break;
                    case 'rangedAttack': creep.rangedAttack(target); break;
                    case 'heal': creep.heal(target); break;
                    case 'rangedHeal': creep.rangedHeal(target); break;
                }
            }
        }
    }
};

module.exports = roleDefender;
