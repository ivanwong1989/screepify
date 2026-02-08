module.exports = {
    /** @param {Creep} creep */
    run: function(creep) {
        const data = creep.memory.taskData;
        // If no task data, we can't do anything. The manager should have assigned one or cleared the mission.
        if (!data) {
            console.log(`[Universal] ${creep.name} has no taskData.`);
            return;
        }
        console.log(`[Universal] ${creep.name} running action: ${data.action} on target: ${data.targetId}`);

        const target = Game.getObjectById(data.targetId);

        // Auto-complete if target is invalid
        if (!target) {
            console.log(`[Universal] ${creep.name} target invalid. Completing task.`);
            this.completeTask(creep);
            return;
        }

        let result = OK;
        const resourceType = data.resourceType || RESOURCE_ENERGY;

        switch (data.action) {
            case 'harvest':
                if (creep.store.getFreeCapacity() === 0) {
                    this.completeTask(creep);
                    break;
                }
                result = creep.harvest(target);
                console.log(`[Universal] ${creep.name} harvest result: ${result}`);
                if (result === OK) {
                    // Busy harvesting
                } else if (result === ERR_NOT_IN_RANGE) {
                    const moveRes = creep.moveTo(target, {visualizePathStyle: {stroke: '#ffaa00'}});
                    console.log(`[Universal] ${creep.name} moving to harvest. Result: ${moveRes}`);
                } else if (result === ERR_INVALID_TARGET || result === ERR_NO_BODYPART) {
                    this.completeTask(creep);
                }
                break;

            case 'transfer':
                result = creep.transfer(target, resourceType);
                console.log(`[Universal] ${creep.name} transfer result: ${result}`);
                if (result === OK) {
                    this.completeTask(creep);
                } else if (result === ERR_NOT_IN_RANGE) {
                    const moveRes = creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}});
                    console.log(`[Universal] ${creep.name} moving to transfer. Result: ${moveRes}`);
                } else if (result === ERR_FULL || result === ERR_NOT_ENOUGH_RESOURCES || result === ERR_INVALID_TARGET) {
                    this.completeTask(creep);
                }
                break;

            case 'build':
                result = creep.build(target);
                console.log(`[Universal] ${creep.name} build result: ${result}`);
                if (result === OK) {
                    const workParts = creep.getActiveBodyparts(WORK);
                    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) <= workParts) {
                        this.completeTask(creep);
                    }
                } else if (result === ERR_NOT_IN_RANGE) {
                    const moveRes = creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}});
                    console.log(`[Universal] ${creep.name} moving to build. Result: ${moveRes}`);
                } else if (result === ERR_NOT_ENOUGH_RESOURCES || result === ERR_INVALID_TARGET) {
                    this.completeTask(creep);
                }
                break;

            case 'repair':
                result = creep.repair(target);
                if (result === OK) {
                    const workParts = creep.getActiveBodyparts(WORK);
                    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) <= workParts || target.hits + (workParts * 100) >= target.hitsMax) {
                        this.completeTask(creep);
                    }
                } else if (result === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}});
                } else if (result === ERR_NOT_ENOUGH_RESOURCES || result === ERR_INVALID_TARGET) {
                    this.completeTask(creep);
                }
                break;

            case 'upgrade':
                result = creep.upgradeController(target);
                console.log(`[Universal] ${creep.name} upgrade result: ${result}`);
                if (result === OK) {
                    const workParts = creep.getActiveBodyparts(WORK);
                    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) <= workParts) {
                        this.completeTask(creep);
                    }
                } else if (result === ERR_NOT_IN_RANGE) {
                    const moveRes = creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}});
                    console.log(`[Universal] ${creep.name} moving to upgrade. Result: ${moveRes}`);
                } else if (result === ERR_NOT_ENOUGH_RESOURCES || result === ERR_INVALID_TARGET) {
                    this.completeTask(creep);
                }
                break;
            
            case 'withdraw':
                result = creep.withdraw(target, resourceType);
                console.log(`[Universal] ${creep.name} withdraw result: ${result}`);
                if (result === OK) {
                    this.completeTask(creep);
                } else if (result === ERR_NOT_IN_RANGE) {
                    const moveRes = creep.moveTo(target, {visualizePathStyle: {stroke: '#ffaa00'}});
                    console.log(`[Universal] ${creep.name} moving to withdraw. Result: ${moveRes}`);
                } else if (result === ERR_FULL || result === ERR_NOT_ENOUGH_RESOURCES || result === ERR_INVALID_TARGET) {
                    this.completeTask(creep);
                }
                break;
                
            case 'pickup':
                result = creep.pickup(target);
                console.log(`[Universal] ${creep.name} pickup result: ${result}`);
                if (result === OK) {
                     this.completeTask(creep);
                } else if (result === ERR_NOT_IN_RANGE) {
                    const moveRes = creep.moveTo(target, {visualizePathStyle: {stroke: '#ffaa00'}});
                    console.log(`[Universal] ${creep.name} moving to pickup. Result: ${moveRes}`);
                } else if (result === ERR_FULL || result === ERR_INVALID_TARGET) {
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
