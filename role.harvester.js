var roleHarvester = {

    /** @param {Creep} creep **/
    run: function(creep) {
	    if(creep.store.getFreeCapacity() > 0) {
            if (creep.memory.random_source_target == "NA" || !creep.memory.random_source_target) {
                var sources = creep.room.find(FIND_SOURCES);
                creep.memory.random_source_target_id = sources[Math.floor(Math.random() * sources.length)].id;
            }

            
            var source = Game.getObjectById(creep.memory.random_source_target_id);
            if(source) {
                // since chosen a source, let's see if the source is dangerous around it. 
                var enemies = creep.memory.random_source_target.findInRange(FIND_HOSTILE_CREEPS,5);
                if(enemies.length == 0) {
                    if(creep.harvest(source) == ERR_NOT_IN_RANGE) {
                        creep.say('🔄 harvest');
                        creep.moveTo(source);
                    }
                }
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