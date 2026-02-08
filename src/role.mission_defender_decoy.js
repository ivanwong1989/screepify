const { result } = require("lodash");

var roleMissionDecoy = {

    /** @param {Creep} creep **/
    run: function(creep) {
        // 1. Handle Rally Flag Logic
        var rallyFlag = Game.flags['FlagRallyCoy'];
        if (rallyFlag && creep.room.name !== rallyFlag.pos.roomName) {
            creep.moveTo(rallyFlag, {visualizePathStyle: {stroke: '#0000ff'}, range: 1});
            return; 
        }

        // 2. Find Target
        var target = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
        
        if(target) {
            // 4. Enhanced Kiting Logic
            // Identify all dangerous hostiles (Attack/RangedAttack)
            var dangerousHostiles = creep.room.find(FIND_HOSTILE_CREEPS, {
                filter: (c) => c.getActiveBodyparts(ATTACK) > 0 || c.getActiveBodyparts(RANGED_ATTACK) > 0
            });

            // If no dangerous hostiles found, but we have a target (e.g. civilian), treat target as the only "danger" to maintain distance from
            if (dangerousHostiles.length === 0) {
                dangerousHostiles = [target];
            }

            var closestDangerous = creep.pos.findClosestByRange(dangerousHostiles);
            var rangeToClosest = closestDangerous ? creep.pos.getRangeTo(closestDangerous) : Infinity;
            var rangeToTarget = creep.pos.getRangeTo(target);

            // If too close to any dangerous creep, flee from ALL of them
            if (rangeToClosest <= 5) {
                var goals = dangerousHostiles.map(h => ({ pos: h.pos, range: 3 }));
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
            } 
            else {
                // We are at a safe distance (range >= 5)
                if (creep.hits < creep.hitsMax * 0.6 && rallyFlag) {
                    creep.moveTo(rallyFlag, {visualizePathStyle: {stroke: '#ff0000'}, range: 1});
                }
                else if (rangeToTarget > 5) {
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
                            // Prioritize range 5 to target, range 6 is acceptable backup
                            if (rangeT === 5) validMoves.push({dir: offset.dir, score: 10});
                            else if (rangeT > 6) validMoves.push({dir: offset.dir, score: 5}); 
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
            // If no enemies, go to rally point if it exists
            if (rallyFlag) {
                creep.moveTo(rallyFlag, {visualizePathStyle: {stroke: '#0000ff'}, range: 1});
            }
        }
	}
};

module.exports = roleMissionDecoy;