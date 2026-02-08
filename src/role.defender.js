var roleDefender = {

    /** @param {Creep} creep **/
    run: function(creep) {
        var target = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
        if(target) {
            if(creep.attack(target) == ERR_NOT_IN_RANGE) {
                creep.moveTo(target, {visualizePathStyle: {stroke: '#ff0000'}, range: 1});
            }
        } else {
            var hostileStructure = creep.pos.findClosestByRange(FIND_HOSTILE_STRUCTURES, {
                filter: (s) => s.structureType != STRUCTURE_CONTROLLER
            });
            if(hostileStructure) {
                if(creep.attack(hostileStructure) == ERR_NOT_IN_RANGE) {
                    creep.moveTo(hostileStructure, {visualizePathStyle: {stroke: '#ff0000'}, range: 1});
                }
            } else {
                // if no hostiles, move near spawn
                var spawn = creep.room.find(FIND_MY_SPAWNS)[0];
                if (spawn) {
                    creep.moveTo(spawn, {range: 2, visualizePathStyle: {stroke: '#ff0000'}});
                }
            }
        }
	}
};

module.exports = roleDefender;