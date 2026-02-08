module.exports = {
    /** @param {Creep} creep */
    run: function(creep) {
        const data = creep.memory.taskData;
        // If no task data, we can't do anything. The manager should have assigned one or cleared the mission.
        if (!data) return;

        const target = Game.getObjectById(data.targetId);

        // Auto-complete if target is invalid
        if (!target) {
            this.completeTask(creep);
            return;
        }

        let result = OK;

        switch (data.action) {
            case 'harvest':
                result = creep.harvest(target);
                if (result === OK) {
                    // Check if full
                    if (creep.store.getFreeCapacity() === 0) {
                        this.completeTask(creep);
                    }
                } else if (result === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target, {visualizePathStyle: {stroke: '#ffaa00'}});
                } else {
                    // If we can't harvest (e.g. busy, no body part), and we are full, finish.
                    if (creep.store.getFreeCapacity() === 0) this.completeTask(creep);
                }
                break;

            case 'transfer':
                result = creep.transfer(target, RESOURCE_ENERGY);
                if (result === OK) {
                    // Check if empty or target full
                    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 || target.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
                        this.completeTask(creep);
                    }
                } else if (result === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}});
                } else if (result === ERR_FULL) {
                    this.completeTask(creep);
                } else if (result === ERR_NOT_ENOUGH_RESOURCES) {
                    this.completeTask(creep);
                }
                break;

            case 'build':
                result = creep.build(target);
                if (result === OK) {
                    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                        this.completeTask(creep);
                    }
                } else if (result === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}});
                } else if (result === ERR_NOT_ENOUGH_RESOURCES) {
                    this.completeTask(creep);
                } else if (result === ERR_INVALID_TARGET) {
                     this.completeTask(creep); // Site finished?
                }
                break;

            case 'upgrade':
                result = creep.upgradeController(target);
                if (result === OK) {
                    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                        this.completeTask(creep);
                    }
                } else if (result === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}});
                } else if (result === ERR_NOT_ENOUGH_RESOURCES) {
                    this.completeTask(creep);
                }
                break;
            
            case 'withdraw':
                result = creep.withdraw(target, RESOURCE_ENERGY);
                if (result === OK) {
                    if (creep.store.getFreeCapacity() === 0 || target.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                        this.completeTask(creep);
                    }
                } else if (result === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target, {visualizePathStyle: {stroke: '#ffaa00'}});
                } else if (result === ERR_FULL) {
                    this.completeTask(creep);
                } else if (result === ERR_NOT_ENOUGH_RESOURCES) {
                    this.completeTask(creep);
                }
                break;
                
            case 'pickup':
                result = creep.pickup(target);
                if (result === OK) {
                     if (creep.store.getFreeCapacity() === 0) {
                        this.completeTask(creep);
                    }
                } else if (result === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target, {visualizePathStyle: {stroke: '#ffaa00'}});
                } else if (result === ERR_FULL) {
                    this.completeTask(creep);
                }
                break;
        }
    },

    completeTask: function(creep) {
        delete creep.memory.missionId;
        delete creep.memory.taskData;
    }
};
