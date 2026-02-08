var roleMissionRangeHealer = {

    /** @param {Creep} creep **/
    run: function(creep) {
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

        // 2. Flee Logic (Highest Priority)
        // Identify all dangerous hostiles (Attack/RangedAttack)
        var dangerousHostiles = creep.room.find(FIND_HOSTILE_CREEPS, {
            filter: (c) => (c.getActiveBodyparts(ATTACK) > 0 || c.getActiveBodyparts(RANGED_ATTACK) > 0) &&
                            c.owner.username !== 'QuanLe'
        });

        var closestDangerous = creep.pos.findClosestByRange(dangerousHostiles);
        var rangeToClosest = closestDangerous ? creep.pos.getRangeTo(closestDangerous) : Infinity;

        // 3. Find Heal Target
        var myCreeps = creep.room.find(FIND_MY_CREEPS, {
            filter: (c) => c.id !== creep.id
        });
        var alliedCreeps =  creep.room.find(FIND_CREEPS, {
            filter: (c) => c.owner && c.owner.username == 'QuanLe' && c.id !== creep.id && (c.getActiveBodyparts(ATTACK) > 0 || c.getActiveBodyparts(RANGED_ATTACK) > 0)
        });

        var defenderRanges = myCreeps.filter(c => c.memory.role == 'mission_defender_range');
        var damagedDefenderRanges = defenderRanges.filter(c => c.hits < c.hitsMax);
        var otherDamaged = myCreeps.filter(c => c.hits < c.hitsMax && c.memory.role !== 'mission_defender_range');
        var alliedDamaged = alliedCreeps.filter(c => c.hits < c.hitsMax);
        var allDamaged = [...damagedDefenderRanges, ...otherDamaged, ...alliedDamaged];
        if (creep.hits < creep.hitsMax) {
            allDamaged.push(creep);
        }
        
        var targetToHeal = null;
        var targetToFollow = null;

        if (allDamaged.length > 0) {
            // Sort by HP percentage (lowest first)
            allDamaged.sort((a, b) => (a.hits / a.hitsMax) - (b.hits / b.hitsMax));
            targetToHeal = allDamaged[0];
            
            if (targetToHeal.id !== creep.id) {
                targetToFollow = targetToHeal;
            }
        }

        if (!targetToFollow && defenderRanges.length > 0) {
            targetToFollow = creep.pos.findClosestByRange(defenderRanges);
            // If everyone is healthy, pre-heal the defender we are following
            if (!targetToHeal) {
                targetToHeal = targetToFollow;
            }
        }

        // For following allies
        if (!targetToFollow && alliedCreeps.length > 0) {
            targetToFollow = creep.pos.findClosestByRange(alliedCreeps);
            // If everyone is healthy, pre-heal the defender we are following
            if (!targetToHeal) {
                targetToHeal = targetToFollow;
            }
        }

        // 4. Heal Logic
        if (targetToHeal) {
            if (creep.pos.isNearTo(targetToHeal)) {
                creep.heal(targetToHeal);
            } else {
                if (creep.pos.inRangeTo(targetToHeal, 3)) {
                    creep.rangedHeal(targetToHeal);
                }
            }
        }

        // 5. Movement Logic
        // If too close to any dangerous creep, flee
        if (rangeToClosest <= 3) {
            var goals = dangerousHostiles.map(h => ({ pos: h.pos, range: 4 }));
            var fleePath = PathFinder.search(creep.pos, goals, {
                flee: true,
                roomCallback: function(roomName) {
                    let cm = new PathFinder.CostMatrix;
                    if(roomName === creep.room.name) {
                        // Avoid other creeps to prevent getting stuck
                        creep.room.find(FIND_CREEPS).forEach(c => cm.set(c.pos.x, c.pos.y, 255));
                    }
                    return cm;
                }
            }).path;
            creep.moveByPath(fleePath);
        } else {
            if (creep.hits < creep.hitsMax * 0.6 && rallyFlag) {
                creep.moveTo(rallyFlag, {visualizePathStyle: {stroke: '#ff0000'}, range: 1});
            } else if (targetToFollow) {
                // Stick close at 2 squares
                if (!creep.pos.inRangeTo(targetToFollow, 2)) {
                    creep.moveTo(targetToFollow, {range: 2, visualizePathStyle: {stroke: '#00ff00'}});
                }
            } else {
                // No targets, go to Rally
                if (rallyFlag && !creep.pos.inRangeTo(rallyFlag, 3)) {
                    creep.moveTo(rallyFlag, {visualizePathStyle: {stroke: '#0000ff'}, range: 1});
                }
            }
        }
	}
};

module.exports = roleMissionRangeHealer;