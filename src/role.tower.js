var roleTower = {
    
    /** @param {StructureTower} tower **/
    run: function(tower) {
        const MAX_REPAIR_HITS = 10000;
        const cache = global.getRoomCache(tower.room);

        // Helper to calculate tower damage based on range
        function getTowerDamage(range) {
            if (range <= 5) return 600;
            if (range >= 20) return 150;
            return 600 - (range - 5) * 30;
        }

        // 1. Tower Defense Logic (Focus Fire & Anti-Heal)
        var currentTarget = null;

        // Check existing target in memory
        if (tower.room.memory.towerTargetId) {
            currentTarget = Game.getObjectById(tower.room.memory.towerTargetId);
            // Validate: Exists, Alive, In Room, Not on Exit
            if (currentTarget) {
                const onExit = currentTarget.pos.x === 0 || currentTarget.pos.x === 49 || currentTarget.pos.y === 0 || currentTarget.pos.y === 49;
                if (onExit || currentTarget.hits <= 0 || currentTarget.room.name !== tower.room.name) {
                    currentTarget = null;
                    delete tower.room.memory.towerTargetId;
                }
            } else {
                delete tower.room.memory.towerTargetId;
            }
        }

        // Find new target if needed
        if (!currentTarget) {
            var hostiles = (cache.hostiles || []).filter(
                c => c.owner.username !== 'QuanLe' && 
                               c.pos.x > 0 && c.pos.x < 49 && c.pos.y > 0 && c.pos.y < 49
            );

            if (hostiles.length > 0) {
                var towers = (cache.structuresByType[STRUCTURE_TOWER] || []).filter(t => t.my);
                var bestTarget = null;
                var bestScore = -Infinity;

                hostiles.forEach(hostile => {
                    // Calculate Net Damage (Incoming Tower Damage - Potential Healing)
                    let totalDamage = 0;
                    towers.forEach(t => {
                        if (t.store.getUsedCapacity(RESOURCE_ENERGY) >= 10) {
                            totalDamage += getTowerDamage(t.pos.getRangeTo(hostile));
                        }
                    });

                    let potentialHeal = hostile.getActiveBodyparts(HEAL) * 12;
                    var nearbyHealers = hostile.pos.findInRange(cache.hostiles || [], 3, {
                        filter: (c) => c.getActiveBodyparts(HEAL) > 0 && c.id !== hostile.id
                    });
                    nearbyHealers.forEach(healer => {
                        let range = healer.pos.getRangeTo(hostile);
                        potentialHeal += (range <= 1) ? (healer.getActiveBodyparts(HEAL) * 12) : (healer.getActiveBodyparts(HEAL) * 4);
                    });

                    let netDamage = totalDamage - potentialHeal;
                    let score = 0;

                    // Scoring Priorities
                    if (netDamage > 0) {
                        score += 10000; // Can break heal
                        score -= (hostile.hits / netDamage); // Kill fastest
                    } else {
                        score += netDamage; // Harass/Drain
                    }

                    if (hostile.getActiveBodyparts(HEAL) > 0) score += 5000;
                    if (hostile.getActiveBodyparts(ATTACK) > 0 || hostile.getActiveBodyparts(RANGED_ATTACK) > 0) score += 1000;
                    
                    var nearStructure = hostile.pos.findInRange(cache.structures || [], 5, {filter: s => s.my}).length > 0;
                    if (nearStructure) score += 2000;

                    score -= tower.pos.getRangeTo(hostile); // Distance penalty

                    if (score > bestScore) {
                        bestScore = score;
                        bestTarget = hostile;
                    }
                });

                if (bestTarget) {
                    currentTarget = bestTarget;
                    tower.room.memory.towerTargetId = bestTarget.id;
                }
            }
        }

        if (currentTarget) {
            tower.attack(currentTarget);
            return;
        }

        // 2. Repair Ramparts
        // If energy > 70% and no "dangerous" enemies are close
        var energyRatio = tower.store.getUsedCapacity(RESOURCE_ENERGY) / tower.store.getCapacity(RESOURCE_ENERGY);
        var dangerousHostiles = (cache.hostiles || []).filter((c) => c.owner.username !== 'QuanLe' && (c.getActiveBodyparts(ATTACK) > 0 || c.getActiveBodyparts(RANGED_ATTACK) > 0 || c.getActiveBodyparts(WORK) > 0));

        if (energyRatio > 0.7 && dangerousHostiles.length === 0) {
            var ramparts = (cache.structuresByType[STRUCTURE_RAMPART] || []).filter(s => s.hits < s.hitsMax && s.hits < MAX_REPAIR_HITS);
            if (ramparts.length > 0) {
                ramparts.sort((a, b) => a.hits - b.hits);
                tower.repair(ramparts[0]);
                return;
            }
        }

        // 5. Idle: Repair damaged structures less than 90% (excluding ramparts/walls) and heal creeps
        var closestDamagedStructure = tower.pos.findClosestByRange(cache.structures || [], {
            filter: (structure) => {
                return (structure.structureType != STRUCTURE_WALL && structure.structureType != STRUCTURE_RAMPART) && 
                (structure.hits < structure.hitsMax) && 
                (structure.hits < MAX_REPAIR_HITS) &&
                (structure.hits < 0.9*structure.hitsMax);
            }
        });

        if(closestDamagedStructure) {
            tower.repair(closestDamagedStructure);
            return;
        }

        var closestDamagedCreep = tower.pos.findClosestByRange(cache.myCreeps || [], {
            filter: (c) => {
                return (c.hits < c.hitsMax) &&
                !c.getActiveBodyparts(HEAL);
            }
        });
        if (closestDamagedCreep) {
            tower.heal(closestDamagedCreep);
            return;
        }
	}
};

module.exports = roleTower;