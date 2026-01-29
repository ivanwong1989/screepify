var roleHarvester = {

    /** @param {Creep} creep **/
    run: function(creep) {
	    if(creep.store.getFreeCapacity() > 0) {
            if (creep.memory.random_source_target_id == "NA" || !creep.memory.random_source_target_id) {
                var sources = creep.room.find(FIND_SOURCES);
                creep.memory.random_source_target_id = sources[Math.floor(Math.random() * sources.length)].id;
            }

            
            var source = Game.getObjectById(creep.memory.random_source_target_id);
            if(source) {
                // since chosen a source, let's see if the source is dangerous around it. 
                var enemies = source.pos.findInRange(FIND_HOSTILE_CREEPS,5);
                // also how about how congested it is around the source
                if(creep.memory.harvesting_wip == 0 || !creep.memory.harvesting_wip) {
                    var congestion = source.pos.findInRange(FIND_CREEPS,2)
                }
                else {
                    var congestion = [0];
                }
                if(enemies.length == 0) {
                    if(congestion.length < 4) {
                        if(creep.harvest(source) == ERR_NOT_IN_RANGE) {
                            //creep.say('🔄 harvest');
                            creep.moveTo(source);
                        }
                        else if (creep.harvest(source) == OK) {
                            //harvesting
                            creep.memory.harvesting_wip = 1;
                        }
                    }
                    else {
                        //choose other sources
                        creep.memory.random_source_target_id = "NA";
                        creep.memory.harvesting_wip = 0;
                    }
                }
                else {
                    // enemies/congestion around the source, reset the source selection and harvesting status
                    creep.memory.random_source_target_id = "NA";
                    creep.memory.harvesting_wip = 0;
                }
            }
        }
        else {
            //creep.say('🔄 going back');
            // free the random target source memory and also harvesting wip status
            creep.memory.random_source_target_id = "NA";
            creep.memory.harvesting_wip = 0;
            if(creep.transfer(Game.spawns['Spawn1'], RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                creep.moveTo(Game.spawns['Spawn1']);
            }
        }
	}
};

module.exports = roleHarvester;