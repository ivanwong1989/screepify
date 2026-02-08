var roleMissionDefenderTank = {

    /** @param {Creep} creep **/
    run: function(creep) {
        const cache = global.getRoomCache(creep.room);

        // 0. Mission Logic
        var squadState = (Memory.missionControl && Memory.missionControl.squads && Memory.missionControl.squads.alpha) ? Memory.missionControl.squads.alpha.state : 'attacking';
        var assemblyFlag = Game.flags['FlagAssembly'];
        var rallyFlag = Game.flags['FlagRallyDefender'];
        
        // If assembling, go to assembly point and wait
        if (squadState === 'assembling' && assemblyFlag) {
            if (!creep.pos.inRangeTo(assemblyFlag, 3)) {
                creep.moveTo(assemblyFlag, {visualizePathStyle: {stroke: '#ffff00'}, range: 1});
            }
            return; // Stop here, don't run attack logic yet
        }

        // 1. Handle Rally Flag Logic
        if (rallyFlag && creep.room.name !== rallyFlag.pos.roomName) {
            creep.moveTo(rallyFlag, {visualizePathStyle: {stroke: '#0000ff'}, range: 1});
            return; 
        }

        // 2. Find Target
        var target = null;
        var squad = (Memory.missionControl && Memory.missionControl.squads && Memory.missionControl.squads.alpha);

        if (squad && squadState === 'attacking') {
            if (squad.targetId) {
                target = Game.getObjectById(squad.targetId);
            }

            // If target is invalid or doesn't exist, find a new one and update squad memory
            if (!target) {
                target = creep.pos.findClosestByRange(cache.hostiles, {
                filter: (c) => c.owner.username !== 'QuanLe' &&
                               creep.pos.getRangeTo(c) <= 4
                });
                if (target) {
                    squad.targetId = target.id;
                } else {
                    squad.targetId = null; // No hostiles, clear target
                }
            }
        } else {
            target = creep.pos.findClosestByRange(cache.hostiles, {
                filter: (c) => c.owner.username !== 'QuanLe'
            });
        }

        if(target) {
            // 3. Attack Logic
            if(creep.attack(target) == ERR_NOT_IN_RANGE) {
                // 4. Tank Movement Logic
                // Move towards the enemy to tank damage
                creep.moveTo(target, {visualizePathStyle: {stroke: '#ff0000'}, range: 1});
            }
        } else {
            // No hostiles, check for hostile structures
            var hostileStructure = creep.pos.findClosestByRange(cache.hostileStructures, {
                filter: (s) => s.structureType != STRUCTURE_CONTROLLER &&
                               s.owner.username != 'QuanLe'
            });
            if(hostileStructure) {
                if(creep.attack(hostileStructure) == ERR_NOT_IN_RANGE) {
                    creep.moveTo(hostileStructure, {visualizePathStyle: {stroke: '#ff0000'}, range: 1});
                }
            } else {
                // If no enemies, go to rally point if it exists
                if (rallyFlag) {
                    creep.moveTo(rallyFlag, {visualizePathStyle: {stroke: '#0000ff'}, range: 1});
                }
            }
        }
	}
};

module.exports = roleMissionDefenderTank;