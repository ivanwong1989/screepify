var roleDefender = {

    /** @param {Creep} creep **/
    run: function(creep) {
        var target = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
        if(target) {
            if(creep.attack(target) == ERR_NOT_IN_RANGE) {
                creep.moveTo(target, {visualizePathStyle: {stroke: '#ff0000'}});
            }
        } else {
            var hostileStructure = creep.pos.findClosestByRange(FIND_HOSTILE_STRUCTURES, {
                filter: (s) => s.structureType != STRUCTURE_CONTROLLER
            });
            if(hostileStructure) {
                if(creep.attack(hostileStructure) == ERR_NOT_IN_RANGE) {
                    creep.moveTo(hostileStructure, {visualizePathStyle: {stroke: '#ff0000'}});
                }
            } else {
                // if no hostiles, move to the rally point Flag2
                if (Game.flags.Flag2) {
                    creep.moveTo(Game.flags.Flag2, {visualizePathStyle: {stroke: '#0000ff'}});
                }
            }
        }
	}
};

module.exports = roleDefender;