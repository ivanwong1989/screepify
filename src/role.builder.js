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
                if(creep.build(targets[0]) == ERR_NOT_IN_RANGE) {
                    creep.moveTo(targets[0], {visualizePathStyle: {stroke: '#ffffff'}});
                }
            } else {
                creep.memory.idling = true;
            }
	    }
	    else {
	        var sources = creep.room.find(FIND_MY_SPAWNS);
            if(sources.length > 0 && sources[0].store.getUsedCapacity(RESOURCE_ENERGY) > 150) {
                if(creep.withdraw(sources[0],RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                    creep.moveTo(sources[0], {visualizePathStyle: {stroke: '#ffaa00'}});
                }
            }
            else {
                creep.memory.idling = true;
            }
	    }

        if (creep.memory.idling) {
            var spawns = creep.room.find(FIND_MY_SPAWNS);
            if (spawns.length > 0) {
                const spawn = spawns[0];
                // If the creep is too close to the spawn, move it away.
                if (creep.pos.getRangeTo(spawn) <= 2) {
                    // We'll use PathFinder with the flee option to find a path away from the spawn
                    // until we are at least 2 tiles away.
                    const path = PathFinder.search(
                        creep.pos,
                        { pos: spawn.pos, range: 2 },
                        { flee: true }
                    );
                    creep.moveByPath(path.path);
                } else {
                    // Otherwise, move to be within range 2. This handles moving closer if too far.
                    creep.moveTo(spawn, {visualizePathStyle: {stroke: '#ffaa00'}, range: 2});
                }
            }
        }
	}
};

module.exports = roleBuilder;