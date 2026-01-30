var roleBuilder = {

    /** @param {Creep} creep **/
    run: function(creep) {

	    if(creep.memory.have_energy && creep.store.getUsedCapacity(RESOURCE_ENERGY) == 0) {
            creep.memory.have_energy = false;
            creep.memory.idling = false;
            creep.say('🔄 harvest');
	    }
	    if(!creep.memory.have_energy && creep.store.getFreeCapacity() == 0) {
	        creep.memory.have_energy = true;
	        creep.memory.idling = false;
	        creep.say('🚧 build');
	    }

	    if(creep.memory.have_energy) {
	        var targets = creep.room.find(FIND_CONSTRUCTION_SITES);
            if(targets.length) {
                creep.memory.idling = false;
                if(creep.build(targets[0]) == ERR_NOT_IN_RANGE) {
                    creep.moveTo(targets[0], {visualizePathStyle: {stroke: '#ffffff'}});
                }
            } else {
                const repairTargets = creep.room.find(FIND_STRUCTURES, {
                    filter: structure => structure.hits < structure.hitsMax
                });

                if (repairTargets.length > 0) {
                    creep.memory.idling = false;
                    repairTargets.sort((a,b) => (a.hits / a.hitsMax) - (b.hits / b.hitsMax));
                    if(creep.repair(repairTargets[0]) == ERR_NOT_IN_RANGE) {
                        creep.moveTo(repairTargets[0], {visualizePathStyle: {stroke: '#00ff00'}});
                    }
                } else {
                    creep.memory.idling = true;
                }
            }
	    }
	    else {
	        var sources = creep.room.find(FIND_MY_SPAWNS);
            if(sources.length > 0 && sources[0].store.getUsedCapacity(RESOURCE_ENERGY) > 150) {
                creep.memory.idling = false;
                if(creep.withdraw(sources[0],RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                    creep.moveTo(sources[0], {visualizePathStyle: {stroke: '#ffaa00'}});
                }
            }
            else {
                creep.memory.idling = true;
            }
	    }

        if (creep.memory.idling) {
            if (Game.flags.Flag1) {
                creep.moveTo(Game.flags.Flag1, {visualizePathStyle: {stroke: '#cc00cc'}});
            }
        }
	}
};

module.exports = roleBuilder;