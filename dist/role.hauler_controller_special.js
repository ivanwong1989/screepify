var roleHaulerSpecialCustom = {

    /** @param {Creep} creep **/
    run: function(creep) {
        const cache = global.getRoomCache(creep.room);

        // State switching based on whether the creep is carrying energy or not
	    if(creep.memory.working && creep.store.getUsedCapacity(RESOURCE_ENERGY) == 0) {
            creep.memory.working = false;
            creep.say('🔄 get energy');
	    }
	    if(!creep.memory.working && creep.store.getFreeCapacity() == 0) {
	        creep.memory.working = true;
	        creep.say('📦 deposit');
	        delete creep.memory.target_storage_id;
	    }

	    if(creep.memory.working) {
            // STATE: DEPOSITING
            // Find the nearest container to the controller
            const containers = cache.structuresByType[STRUCTURE_CONTAINER] || [];
            const validContainers = containers.filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
            var target = creep.room.controller.pos.findClosestByPath(validContainers);

            if(target) {
                // Try to transfer energy to the target.
                if(creep.transfer(target, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                    // If not in range, move towards it.
                    creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}, reusePath:10, range: 1});
                }
            }
	    }
	    else {
            // STATE: GETTING ENERGY
            let storage;
            // If we have a target storage in memory, use it.
            if (creep.memory.target_storage_id) {
                storage = Game.getObjectById(creep.memory.target_storage_id);
                // If the storage is now empty, forget it.
                if (storage && storage.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                    delete creep.memory.target_storage_id;
                    storage = null;
                }
            }

            // If we don't have a valid storage target, find one.
            if (!storage) {
                const storages = cache.structuresByType[STRUCTURE_STORAGE] || [];
                const validStorages = storages.filter(s => s.store.getUsedCapacity(RESOURCE_ENERGY) > 0);
                storage = creep.pos.findClosestByPath(validStorages);

                if (storage) {
                    creep.memory.target_storage_id = storage.id;
                }
            }

            // No storage detected, then try to find containers that is not within 2 range of the controller
            // Don't mind the var named storage.. it's weird here i know. 
            if (!storage) {
                const containers = cache.structuresByType[STRUCTURE_CONTAINER] || [];
                const validContainers = containers.filter(s => 
                    s.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
                    (!creep.room.controller || !s.pos.inRangeTo(creep.room.controller, 2))
                );
                storage = creep.pos.findClosestByPath(validContainers);
            }

            if (storage) {
                if (creep.withdraw(storage, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                    creep.moveTo(storage, {visualizePathStyle: {stroke: '#ffaa00'}, reusePath:10, range: 1});
                }
            }
	    }
	}
};

module.exports = roleHaulerSpecialCustom;