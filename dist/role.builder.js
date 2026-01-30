var roleBuilder = {

    /** @param {Creep} creep **/
    run: function(creep) {

	    if(creep.memory.building && creep.store[RESOURCE_ENERGY] == 0) {
            creep.memory.building = false;
            creep.say('🔄 harvest');
	    }
	    if(!creep.memory.building && creep.store.getFreeCapacity() == 0) {
	        creep.memory.building = true;
	        creep.say('🚧 build');
	    }

	    if(creep.memory.building) {
	        var targets = creep.room.find(FIND_CONSTRUCTION_SITES);
            if(targets.length) {
                if(creep.build(targets[0]) == ERR_NOT_IN_RANGE) {
                    creep.moveTo(targets[0], {visualizePathStyle: {stroke: '#ffffff'}});
                }
            }
	    }
	    else {
	        var sources = creep.room.find(FIND_MY_SPAWNS);
            if(sources[0].store.getUsedCapacity(RESOURCE_ENERGY) > 150) {
                if(creep.withdraw(sources[0],RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                    creep.moveTo(sources[0], {visualizePathStyle: {stroke: '#ffaa00'}});
                }
            }
            else {
                // since not doing anything, have the builder be two range away from spawn to not clog up the area. 
                creep.moveTo(sources[0], {visualizePathStyle: {stroke: '#ffaa00'}, range: 2});
            }

	    }
	}
};

module.exports = roleBuilder;