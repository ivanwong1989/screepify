var roleUniversal = {
    /**
     * The universal role creep logic.
     * Reads 'task' from memory and executes it.
     * @param {Creep} creep
     */
    run: function(creep) {
        const task = creep.memory.task;
        if (!task) return;

        const target = Game.getObjectById(task.targetId);

        // If the target is no longer valid (despawned, destroyed), clear the task.
        if (!target && task.action !== 'drop') {
            delete creep.memory.task;
            return;
        }

        switch(task.action) {
            case 'move':
                if (target && !creep.pos.isEqualTo(target.pos)) {
                    creep.moveTo(target);
                }
                break;
            case 'harvest':
                if (creep.harvest(target) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target);
                }
                break;
            case 'transfer':
                if (creep.transfer(target, task.resourceType) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target);
                }
                break;
            case 'withdraw':
                if (creep.withdraw(target, task.resourceType) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target);
                }
                break;
            case 'pickup':
                if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target);
                }
                break;
            case 'upgrade':
                if (creep.upgradeController(target) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target);
                }
                break;
            case 'build':
                if (creep.build(target) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target);
                }
                break;
            case 'repair':
                if (creep.repair(target) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target);
                }
                break;
            case 'repair':
                if (creep.repair(target) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target);
                }
                break;
            case 'drop':
                creep.drop(task.resourceType);
                break;
        }
    }
};

module.exports = roleUniversal;
