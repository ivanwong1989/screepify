var roleHarvester = {

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
	        delete creep.memory.target_container_id;
	        delete creep.memory.target_source_id;
	    }

	    if(creep.memory.working) {
            // STATE: DEPOSITING
            // Find the closest structure that needs energy.
            var targets = [];
            if (cache.structuresByType[STRUCTURE_EXTENSION]) targets.push(...cache.structuresByType[STRUCTURE_EXTENSION]);
            if (cache.structuresByType[STRUCTURE_SPAWN]) targets.push(...cache.structuresByType[STRUCTURE_SPAWN]);
            if (cache.structuresByType[STRUCTURE_TOWER]) targets.push(...cache.structuresByType[STRUCTURE_TOWER]);

            var target = creep.pos.findClosestByPath(targets, {
                filter: (structure) => structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0
            });

            if(target) {
                // Try to transfer energy to the target.
                if(creep.transfer(target, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                    // If not in range, move towards it.
                    creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}, range: 1});
                }
            } else {
                // Since no target, move back to Spawn area and wait nearby (range 3)
                const spawns = (cache.structuresByType[STRUCTURE_SPAWN] || []).filter(s => s.my);
                const spawn = creep.pos.findClosestByRange(spawns);
                if (spawn) {
                    creep.moveTo(spawn, {range: 2, visualizePathStyle: {stroke: '#ffffff'}});
                }
            }
	    }
	    else {
            // STATE: GETTING ENERGY
            // Look for opportunistic ruins
            const ruins = (cache.ruins || []).filter(r => r.store.getUsedCapacity(RESOURCE_ENERGY) > 0);
            let ruin = creep.pos.findClosestByPath(ruins);

            if (ruin) {
                if (creep.withdraw(ruin, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                    creep.moveTo(ruin, {visualizePathStyle: {stroke: '#ffaa00'}, range: 1});
                }
                return;
            }

            let container;
            // If we have a target container in memory, use it.
            if (creep.memory.target_container_id) {
                container = Game.getObjectById(creep.memory.target_container_id);
                // If the container is now empty, forget it.
                if (container && container.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                    delete creep.memory.target_container_id;
                    container = null;
                }
            }

            // If we don't have a valid container target, find one.
            if (!container) {
                const containers = (cache.structuresByType[STRUCTURE_CONTAINER] || []).filter(i => i.store.getUsedCapacity(RESOURCE_ENERGY) > 0);
                container = creep.pos.findClosestByPath(containers);
                if (container) {
                    creep.memory.target_container_id = container.id;
                }
            }

            if (container) {
                if (creep.withdraw(container, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                    creep.moveTo(container, {visualizePathStyle: {stroke: '#ffaa00'}, range: 1});
                }
                return;
            } 
            
            if (!container) {
                // If no containers, harvest from a source.
                let source;
                // If we have a target source in memory, use it.
                if (creep.memory.target_source_id) {
                    source = Game.getObjectById(creep.memory.target_source_id);
                    // If the source is now depleted, forget it.
                    if (source && source.energy === 0) {
                        delete creep.memory.target_source_id;
                        source = null;
                    }
                }

                // If we don't have a valid source target, find one.
                if (!source) {
                    const sources = creep.room.find(FIND_SOURCES_ACTIVE);

                    // Filter out sources that are too crowded.
                    const uncongestedSources = sources.filter(s => s.pos.findInRange(cache.myCreeps, 2).length < 4);

                    if (uncongestedSources.length > 0) {
                        // If there are uncongested sources, find the closest one.
                        source = creep.pos.findClosestByPath(uncongestedSources);
                    } else if (sources.length > 0) {
                        // If all sources are congested, just find the closest one and move towards it to wait.
                        source = creep.pos.findClosestByPath(sources);
                    }
                    
                    if (source) {
                        creep.memory.target_source_id = source.id;
                    }
                }

                if(source) {
                    if(creep.harvest(source) == ERR_NOT_IN_RANGE) {
                        creep.moveTo(source, {visualizePathStyle: {stroke: '#ffaa00'}, range: 1});
                    }
                }
            }
	    }
	}
};

module.exports = roleHarvester;