var roleMissionDefenderRange = {

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
            // Priority 1: Immediate threat (Attacker/Ranged within range 4)
            // This overrides squad target to prevent chasing kiters while ignoring close threats
            var immediateThreat = creep.pos.findClosestByRange(cache.hostiles, {
                filter: (c) => (c.getActiveBodyparts(ATTACK) > 0 || c.getActiveBodyparts(RANGED_ATTACK) > 0) &&
                               creep.pos.getRangeTo(c) <= 4 &&
                               c.owner.username != 'QuanLe'
            });

            if (immediateThreat) {
                target = immediateThreat;
                squad.targetId = target.id;
            } else {
                if (squad.targetId) {
                    target = Game.getObjectById(squad.targetId);
                }

                // If target is invalid or doesn't exist, find a new one and update squad memory
                if (!target) {
                    target = creep.pos.findClosestByRange(cache.hostiles, {
                        filter: (c) => c.owner.username !== 'QuanLe'
                    });
                    if (target) {
                        squad.targetId = target.id;
                    } else {
                        squad.targetId = null; // No hostiles, clear target
                    }
                }
            }
        } else {
            target = creep.pos.findClosestByRange(cache.hostiles, {
                        filter: (c) => c.owner.username !== 'QuanLe'
            });
        }

        if(target) {
            // 3. Attack Logic
            var resultattack = creep.rangedAttack(target);
            log("result attack: ", resultattack);

            // Identify all dangerous hostiles (Attack/RangedAttack)
            var dangerousHostiles = cache.hostiles.filter(
                (c) => (c.getActiveBodyparts(ATTACK) > 0 || c.getActiveBodyparts(RANGED_ATTACK) > 0) &&
                               c.owner.username != 'QuanLe'
            );
            
            // If no dangerous hostiles found, but we have a target (e.g. civilian), treat target as the only "danger" to maintain distance from
            if (dangerousHostiles.length === 0) {
                dangerousHostiles = [target];
            }

            var closestDangerous = creep.pos.findClosestByRange(dangerousHostiles);
            var rangeToClosest = closestDangerous ? creep.pos.getRangeTo(closestDangerous) : Infinity;
            var rangeToTarget = creep.pos.getRangeTo(target);

            // If too close to any dangerous creep, flee from ALL of them
            if (rangeToClosest <= 3) {
                var goals = dangerousHostiles.map(h => ({ pos: h.pos, range: 3 }));
                var fleePath = PathFinder.search(creep.pos, goals, {
                    flee: true,
                    roomCallback: function(roomName) {
                        let cm = new PathFinder.CostMatrix;
                        if(roomName === creep.room.name) {
                            // Avoid other creeps to prevent getting stuck
                            if (cache.myCreeps) cache.myCreeps.forEach(c => cm.set(c.pos.x, c.pos.y, 255));
                            if (cache.hostiles) cache.hostiles.forEach(c => cm.set(c.pos.x, c.pos.y, 255));
                        }
                        return cm;
                    }
                }).path;
                creep.moveByPath(fleePath);
            } 
            else {
                // We are at a safe distance (range >= 3)
                if (creep.hits < creep.hitsMax * 0.6 && rallyFlag) {
                    creep.moveTo(rallyFlag, {visualizePathStyle: {stroke: '#ff0000'}, range: 1});
                }
                else if (rangeToTarget > 3) {
                    // Too far from target, approach
                    creep.moveTo(target, {range: 3, visualizePathStyle: {stroke: '#ff0000'}});
                } else {
                    // We are at optimal range (3). 
                    // "Prefer to run in circles" -> Try to move to a lateral position that maintains range 3
                    
                    // Check all adjacent tiles
                    let adjacent = [
                        {x: 0, y: -1, dir: TOP}, {x: 1, y: -1, dir: TOP_RIGHT}, {x: 1, y: 0, dir: RIGHT},
                        {x: 1, y: 1, dir: BOTTOM_RIGHT}, {x: 0, y: 1, dir: BOTTOM}, {x: -1, y: 1, dir: BOTTOM_LEFT},
                        {x: -1, y: 0, dir: LEFT}, {x: -1, y: -1, dir: TOP_LEFT}
                    ];
                    
                    // Shuffle to randomize direction if scores are equal
                    adjacent.sort(() => Math.random() - 0.5);

                    let validMoves = [];

                    adjacent.forEach(offset => {
                        let x = creep.pos.x + offset.x;
                        let y = creep.pos.y + offset.y;
                        
                        // Check boundaries and terrain
                        if (x < 1 || x > 48 || y < 1 || y > 48) return;
                        if (Game.map.getRoomTerrain(creep.room.name).get(x, y) === TERRAIN_MASK_WALL) return;
                        
                        // Check creep occupancy
                        let pos = new RoomPosition(x, y, creep.room.name);
                        if (pos.lookFor(LOOK_CREEPS).length > 0) return;

                        // Evaluate this position
                        let rangeT = pos.getRangeTo(target);
                        let safe = !dangerousHostiles.some(h => pos.getRangeTo(h) <= 2);
                        
                        if (safe) {
                            // Prioritize range 3 to target, range 4 is acceptable backup
                            if (rangeT === 3) validMoves.push({dir: offset.dir, score: 10});
                            else if (rangeT > 3) validMoves.push({dir: offset.dir, score: 5}); 
                        }
                    });

                    // Pick the best move to keep moving
                    if (validMoves.length > 0) {
                        validMoves.sort((a, b) => b.score - a.score);
                        creep.move(validMoves[0].dir);
                    }
                }
            }
        } else {
            // No hostiles, check for hostile structures
            var hostileStructure = creep.pos.findClosestByRange(cache.hostileStructures, {
                filter: (s) => s.structureType != STRUCTURE_CONTROLLER &&
                               s.owner.username != 'QuanLe'
            });
            if(hostileStructure) {
                creep.rangedAttack(hostileStructure);
                if(creep.pos.getRangeTo(hostileStructure) > 1) {
                    creep.moveTo(hostileStructure, {range: 1, visualizePathStyle: {stroke: '#ff0000'}});
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

module.exports = roleMissionDefenderRange;