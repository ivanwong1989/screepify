var roleBuilder = {

    /** @param {Creep} creep **/
    run: function(creep) {
        const cache = global.getRoomCache(creep.room);

        if (creep.memory.homeRoom && creep.room.name !== creep.memory.homeRoom) {
            // Try to find a spawn in the home room if visible
            const homeRoom = Game.rooms[creep.memory.homeRoom];
            if (homeRoom) {
                const homeCache = global.getRoomCache(homeRoom);
                const spawns = homeCache.structuresByType[STRUCTURE_SPAWN] || [];
                const spawn = spawns.find(s => s.my);
                if (spawn) {
                    creep.moveTo(spawn, {reusePath: 15, range: 1});
                    return;
                }
            }
            
            // If no spawn visible or found, just move to the room center
            const homePos = new RoomPosition(25, 25, creep.memory.homeRoom);
            creep.moveTo(homePos, {reusePath: 15, range: 1});
            return;
        }

	    if(creep.memory.building && creep.store.getUsedCapacity(RESOURCE_ENERGY) == 0) {
            creep.memory.building = false;
            creep.say('🔄 get energy');
	    }
	    if(!creep.memory.building && creep.store.getFreeCapacity() == 0) {
	        creep.memory.building = true;
	        creep.say('🚧 build');
	        delete creep.memory.target_container_id;
	    }

	    if(creep.memory.building) {
	        var targets = cache.constructionSites || [];
            if(targets.length) {
                if(creep.build(targets[0]) == ERR_NOT_IN_RANGE) {
                    creep.moveTo(targets[0], {reusePath: 15, range: 1});
                }
            } else {
                var target = null;
                // 1. Check existing target
                if (creep.memory.repairTargetId) {
                    target = Game.getObjectById(creep.memory.repairTargetId);
                    // Check if valid and needs repair
                    if (!target || target.hits >= target.hitsMax) {
                        target = null;
                        delete creep.memory.repairTargetId;
                    }
                }

                // 2. Find new target if needed
                if (!target) {
                    const types = [STRUCTURE_SPAWN, STRUCTURE_TOWER, STRUCTURE_CONTAINER, STRUCTURE_STORAGE, STRUCTURE_ROAD];
                    let candidates = [];
                    types.forEach(t => {
                        if (cache.structuresByType[t]) {
                            candidates = candidates.concat(cache.structuresByType[t]);
                        }
                    });

                    const flag = Game.flags['FlagDismantle'];
                    const repairTargets = candidates.filter(structure => {
                        if (flag && structure.pos.isEqualTo(flag.pos)) return false;
                        return structure.hits < structure.hitsMax;
                    });
                    if (repairTargets.length > 0) {
                        repairTargets.sort((a,b) => (a.hits / a.hitsMax) - (b.hits / b.hitsMax));
                        target = repairTargets[0];
                        creep.memory.repairTargetId = target.id;
                    }
                }

                if (target) {
                    if(creep.repair(target) == ERR_NOT_IN_RANGE) {
                        creep.moveTo(target, {reusePath: 15, range: 1});
                        
                        // Opportunistic repair
                        let candidates = [];
                        for (const type in cache.structuresByType) {
                            if (type !== STRUCTURE_WALL && type !== STRUCTURE_RAMPART) {
                                candidates = candidates.concat(cache.structuresByType[type]);
                            }
                        }
                        const nearby = creep.pos.findInRange(candidates, 3, {
                            filter: (s) => s.hits < s.hitsMax
                        });
                        if (nearby.length > 0) {
                            nearby.sort((a,b) => (a.hits/a.hitsMax) - (b.hits/b.hitsMax));
                            creep.repair(nearby[0]);
                        }
                    }
                } else {
                    // if nothing to build or repair, upgrade controller
                    if(creep.room.controller) {
                        if(creep.upgradeController(creep.room.controller) == ERR_NOT_IN_RANGE) {
                            creep.moveTo(creep.room.controller, {reusePath: 15, range: 1});
                        }
                    }
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
                    creep.moveTo(ruin, {reusePath: 15, range: 1});
                }
                return;
            }

            let container;
            // If we have a target container in memory, use it.
            if (creep.memory.target_container_id) {
                container = Game.getObjectById(creep.memory.target_container_id);
                // If the container is now empty or doesn't exist, forget it.
                if (!container || container.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                    delete creep.memory.target_container_id;
                    container = null;
                }
            }

            // If we don't have a valid container target, find one (container or storage).
            if (!container) {
                let candidates = [];
                if (cache.structuresByType[STRUCTURE_CONTAINER]) candidates = candidates.concat(cache.structuresByType[STRUCTURE_CONTAINER]);
                if (cache.structuresByType[STRUCTURE_STORAGE]) candidates = candidates.concat(cache.structuresByType[STRUCTURE_STORAGE]);
                
                const validContainers = candidates.filter(i => i.store.getUsedCapacity(RESOURCE_ENERGY) > 0);
                container = creep.pos.findClosestByPath(validContainers);
                if (container) {
                    creep.memory.target_container_id = container.id;
                }
            }

            if (container) {
                if (creep.withdraw(container, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                    creep.moveTo(container, {reusePath: 15, range: 1});
                }
            } else {
                // If no containers/storage, harvest from a source.
                var source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
                if(source) {
                    if(creep.harvest(source) == ERR_NOT_IN_RANGE) {
                        creep.moveTo(source, {reusePath: 15, range: 1});
                    }
                }
            }
	    }
	}
};

module.exports = roleBuilder;