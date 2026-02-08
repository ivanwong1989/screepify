var roleHarvesterBig = {

    /** @param {Creep} creep **/
    run: function(creep) {
        const cache = global.getRoomCache(creep.room);

        // State switching based on whether the creep is carrying energy or not
        if(creep.memory.working && creep.store.getUsedCapacity(RESOURCE_ENERGY) == 0) {
            creep.memory.working = false;
            creep.say('🔄 harvest');
        }
        if(!creep.memory.working && creep.store.getFreeCapacity() == 0) {
            creep.memory.working = true;
            creep.say('📦 deposit');
        }

        // Check for haulers in the room
        const haulers = (cache.myCreeps || []).filter((c) => c.memory && c.memory.role == 'hauler');

        if (haulers.length > 0) {
            // Logic when haulers exist: Stick to source and fill nearby container.
            
            // 1. Find Source (and persist it to avoid switching)
            let source = null;
            if (creep.memory.target_source_id) {
                source = Game.getObjectById(creep.memory.target_source_id);

                // Validate if another big harvester is targeting this source
                if (source) {
                    const otherHarvesters = (cache.myCreeps || []).filter((c) => c.memory && c.memory.role == 'harvester_big' && c.ticksToLive > 100 && c.id !== creep.id);
                    
                    const conflictingCreeps = otherHarvesters.filter(c => c.memory && c.memory.target_source_id === source.id);

                    // Dynamic Max Harvesters based on WORK parts and physical space
                    const terrain = creep.room.getTerrain();
                    let freeSpace = 0;
                    for (let dx = -1; dx <= 1; dx++) {
                        for (let dy = -1; dy <= 1; dy++) {
                            if (dx === 0 && dy === 0) continue;
                            if (terrain.get(source.pos.x + dx, source.pos.y + dy) !== TERRAIN_MASK_WALL) freeSpace++;
                        }
                    }
                    const myWorkParts = creep.body.filter(p => p.type === WORK).length;
                    const maxHarvesters = Math.min(Math.ceil(5 / myWorkParts), freeSpace);

                    // Resolve race condition: yield if there are enough creeps with higher priority (smaller ID) already targeting this
                    const higherPriorityCreeps = conflictingCreeps.filter(c => c.id < creep.id);
                    
                    if (higherPriorityCreeps.length >= maxHarvesters) {
                        source = null;
                        delete creep.memory.target_source_id;
                    }
                }
            }
            
            if (!source) {
                if (creep.memory.target_source_override && creep.memory.target_source_override !== 'NA') {
                    source = Game.getObjectById(creep.memory.target_source_override);
                } else {
                    var sources = creep.room.find(FIND_SOURCES_ACTIVE);
                    
                    // Get other harvesters to check their memory
                    const otherHarvesters = (cache.myCreeps || []).filter((c) => c.memory && c.memory.role == 'harvester_big' && c.ticksToLive > 100 && c.id !== creep.id);
                    const takenSourceIds = otherHarvesters.map(c => c.memory && c.memory.target_source_id);

                    // Dynamic Max Harvesters based on WORK parts
                    const terrain = creep.room.getTerrain();
                    const myWorkParts = creep.body.filter(p => p.type === WORK).length;
                    const maxHarvesters = Math.ceil(5 / myWorkParts);

                    // Find the source with the most available capacity (less congested)
                    let bestSource = null;
                    let bestVacancy = -Infinity;

                    sources.forEach(s => {
                        let freeSpace = 0;
                        for (let dx = -1; dx <= 1; dx++) {
                            for (let dy = -1; dy <= 1; dy++) {
                                if (dx === 0 && dy === 0) continue;
                                if (terrain.get(s.pos.x + dx, s.pos.y + dy) !== TERRAIN_MASK_WALL) freeSpace++;
                            }
                        }
                        
                        const limit = Math.min(maxHarvesters, freeSpace);
                        const assignedCount = takenSourceIds.filter(id => id === s.id).length;
                        const vacancy = limit - assignedCount;

                        if (vacancy > 0) {
                            // Prioritize higher vacancy, then distance
                            if (vacancy > bestVacancy || (vacancy === bestVacancy && creep.pos.getRangeTo(s) < (bestSource ? creep.pos.getRangeTo(bestSource) : Infinity))) {
                                bestVacancy = vacancy;
                                bestSource = s;
                            }
                        }
                    });
                    
                    source = bestSource;
                }
                
                if (source) {
                    creep.memory.target_source_id = source.id;
                }
            }
            
            if (source) {
                if (creep.memory.working) {
                    // 3. Transfer to nearby container if we are full
                    // Find container near SOURCE (range 2)
                    const containers = cache.structuresByType[STRUCTURE_CONTAINER] || [];
                    const container = containers.find(s => s.pos.inRangeTo(source, 2) && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
                    
                    if (container) {
                        const transferResult = creep.transfer(container, RESOURCE_ENERGY);
                        if (transferResult == ERR_NOT_IN_RANGE) {
                            creep.moveTo(container, {visualizePathStyle: {stroke: '#ffffff'}, maxRooms:1, range: 1});
                        }
                    }

                    // if (!container) {
                    //     // Transfer to spawn and extensions if they are not full
                    //     target = creep.pos.findClosestByPath(FIND_STRUCTURES, {
                    //         filter: (structure) => {
                    //             return (structure.structureType == STRUCTURE_EXTENSION ||
                    //                     structure.structureType == STRUCTURE_SPAWN ||
                    //                     structure.structureType == STRUCTURE_TOWER) &&
                    //                 structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
                    //         }
                    //     });
                    //     if(creep.transfer(target, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                    //         creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}, maxRooms:1});
                    //     }
                    // }
                } else {
                    // 2. Harvest
                    const harvestResult = creep.harvest(source);
                    if (harvestResult == ERR_NOT_IN_RANGE) {
                        creep.moveTo(source, {visualizePathStyle: {stroke: '#ffaa00'}, maxRooms:1, range: 1});
                    }
                }
            }
            return; 
        }


        // If haulers does not exist, then the big harvester have to kinda be a non static harvester until dedicated haulers are up
	    if(creep.memory.working) {
	        // If working, find the nearest container and transfer energy to it
            const containers = (cache.structuresByType[STRUCTURE_CONTAINER] || []).filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
            var target = creep.pos.findClosestByPath(containers);

            if (!target) {
                // if no container, fall back to spawn, extension or tower
                let targets = [];
                if (cache.structuresByType[STRUCTURE_EXTENSION]) targets.push(...cache.structuresByType[STRUCTURE_EXTENSION]);
                if (cache.structuresByType[STRUCTURE_SPAWN]) targets.push(...cache.structuresByType[STRUCTURE_SPAWN]);
                if (cache.structuresByType[STRUCTURE_TOWER]) targets.push(...cache.structuresByType[STRUCTURE_TOWER]);
                targets = targets.filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
                target = creep.pos.findClosestByPath(targets);
            }

            if(target) {
                if(creep.transfer(target, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                    creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}, maxRooms:1, range: 1});
                }
            } else {
                // Since no target, move back to Spawn area and wait nearby (range 3)
                const spawns = (cache.structuresByType[STRUCTURE_SPAWN] || []).filter(s => s.my);
                const spawn = spawns[0];
                if (spawn) {
                    creep.moveTo(spawn, {range: 2, visualizePathStyle: {stroke: '#ffffff'}, maxRooms:1});
                }
            } 
	    }
	    else {
	        // If not working, find a source and harvest from it
            var source;
            if (creep.memory.target_source_override && creep.memory.target_source_override !== 'NA') {
                source = Game.getObjectById(creep.memory.target_source_override);
            } else {
                var sources = creep.room.find(FIND_SOURCES_ACTIVE);

                // Filter sources to find ones not occupied by another BigHarvester
                var unoccupiedSources = sources.filter(source => {
                    const nearby = (cache.myCreeps || []).filter(c => c.pos.inRangeTo(source, 1) && c.memory && c.memory.role == 'harvester_big' && c.id !== creep.id);
                    return nearby.length === 0;
                });

                if (unoccupiedSources.length > 0) {
                    // Find the closest of the unoccupied sources
                    source = creep.pos.findClosestByPath(unoccupiedSources);
                } else if (sources.length > 0) {
                    // If all sources are occupied, just go to the closest one and wait
                    source = creep.pos.findClosestByPath(sources);
                }
            }

            if(source) {
                if(creep.harvest(source) == ERR_NOT_IN_RANGE) {
                    creep.moveTo(source, {visualizePathStyle: {stroke: '#ffaa00'}, maxRooms:1, range: 1});
                }
            }
	    }
	}
};

module.exports = roleHarvesterBig;