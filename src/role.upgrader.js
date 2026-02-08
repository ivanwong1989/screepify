var roleUpgrader = {
    
    /** @param {Creep} creep **/
    run: function(creep) {
        const cache = global.getRoomCache(creep.room);

        if(creep.memory.unloading && creep.store.getUsedCapacity(RESOURCE_ENERGY) == 0) {
            creep.memory.unloading = 0;
            creep.say('🔄 get energy');
        }
        if(!creep.memory.unloading && creep.store.getFreeCapacity() == 0) {
            creep.memory.unloading = 1;
            creep.say('⚡ upgrade');
        }

	    if(!creep.memory.unloading) {
            var dropped = (cache.dropped || []).filter((resource) => resource.resourceType == RESOURCE_ENERGY);

            var structures = [];
            if (cache.structuresByType[STRUCTURE_CONTAINER]) structures = structures.concat(cache.structuresByType[STRUCTURE_CONTAINER]);
            if (cache.structuresByType[STRUCTURE_STORAGE]) structures = structures.concat(cache.structuresByType[STRUCTURE_STORAGE]);
            
            structures = structures.filter((structure) => structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0);

            var target = creep.pos.findClosestByPath(dropped.concat(structures));

            if (!target) {
                var spawns = (cache.structuresByType[STRUCTURE_SPAWN] || []).filter(s => s.my);
                target = creep.pos.findClosestByPath(spawns);
            }

            if(target) {
                if (target instanceof Resource) {
                    if(creep.pickup(target) == ERR_NOT_IN_RANGE) {
                        creep.moveTo(target, {visualizePathStyle: {stroke: '#ffaa00'}, reusePath:10, range: 1});
                    }
                } else {
                    if(creep.withdraw(target, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                        creep.moveTo(target, {visualizePathStyle: {stroke: '#ffaa00'}, reusePath:10, range: 1});
                    }
                }
            }
        }
        else {
            if(creep.upgradeController(creep.room.controller) == ERR_NOT_IN_RANGE || !creep.pos.inRangeTo(creep.room.controller,2)) {
                creep.moveTo(creep.room.controller, {visualizePathStyle: {stroke: '#ffffff'}, reusePath:10, range:2});
            }
        }
	}
};

module.exports = roleUpgrader;