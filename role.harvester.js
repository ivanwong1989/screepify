var roleHarvester = {

    /** @param {Creep} creep **/
    run: function(creep) {
	    if(creep.store.getFreeCapacity() > 0) {
            var sources = creep.room.find(FIND_SOURCES);
            if (creep.memory.random_source_target == "NA") {
                var random_source_target = sources[Math.floor(Math.random() * sources.length)];
            }
            if(creep.harvest(random_source_target) == ERR_NOT_IN_RANGE) {
                creep.say('🔄 harvest');
                creep.moveTo(random_source_target);
            }
        }
        else {
            creep.say('🔄 going back');
            // free the random target source memory
            creep.memory.random_source_target = "NA";
            if(creep.transfer(Game.spawns['Spawn1'], RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                creep.moveTo(Game.spawns['Spawn1']);
            }
        }
	}
};

module.exports = roleHarvester;