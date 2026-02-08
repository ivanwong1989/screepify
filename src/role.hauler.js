const { drop } = require("lodash");

var roleHauler = {

    /** @param {Creep} creep **/
    run: function(creep) {
        const cache = global.getRoomCache(creep.room);

        // Traffic Jam Detection
        if (creep.memory.resolvingJam) {
            creep.say('JamFix');
            
            let stopResolving = false;

            // Check if we have moved far enough (4 tiles) from where we got stuck
            if (creep.memory.jamOrigin) {
                const jamOrigin = new RoomPosition(creep.memory.jamOrigin.x, creep.memory.jamOrigin.y, creep.memory.jamOrigin.roomName);
                if (creep.pos.getRangeTo(jamOrigin) >= 4) {
                    stopResolving = true;
                }
            } else {
                stopResolving = true;
            }

            if (!stopResolving) {
                var spawns = cache.structuresByType[STRUCTURE_SPAWN] || [];
                var spawn = spawns.find(s => s.my);
                if (spawn) {
                    if (creep.pos.inRangeTo(spawn, 3)) {
                        stopResolving = true;
                    } else {
                        creep.moveTo(spawn, {reusePath: 5, range: 1});
                        return;
                    }
                } else {
                    stopResolving = true;
                }
            }

            if (stopResolving) {
                creep.memory.resolvingJam = false;
                creep.memory.stuckCount = 0;
                delete creep.memory.jamOrigin;
                if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                    creep.memory.working = true;
                    delete creep.memory.target_source_id;
                }
            }
        }

        if (creep.memory.moving && creep.fatigue === 0) {
            if (creep.memory.lastPos && creep.pos.x === creep.memory.lastPos.x && creep.pos.y === creep.memory.lastPos.y) {
                creep.memory.stuckCount = (creep.memory.stuckCount || 0) + 1;
            } else {
                creep.memory.stuckCount = 0;
            }
        } else {
            creep.memory.stuckCount = 0;
        }
        creep.memory.lastPos = {x: creep.pos.x, y: creep.pos.y};
        creep.memory.moving = false;

        if ((creep.memory.stuckCount || 0) >= 4) {
            creep.memory.resolvingJam = true;
            creep.memory.jamOrigin = {x: creep.pos.x, y: creep.pos.y, roomName: creep.room.name};
            delete creep.memory.target_deposit_id;
            delete creep.memory.target_source_id;
            creep.say('Jam!');
            return;
        }

        // State switching based on whether the creep is carrying energy or not
	    if(creep.memory.working && creep.store.getUsedCapacity(RESOURCE_ENERGY) == 0) {
            creep.memory.working = false;
            creep.say('🔄 get energy');
            delete creep.memory.target_deposit_id;
	    }
	    if(!creep.memory.working && creep.store.getFreeCapacity() == 0) {
	        creep.memory.working = true;
	        creep.say('📦 deposit');
            delete creep.memory.target_source_id;
	    }

	    if(creep.memory.working) {
            // STATE: DEPOSITING
            var target = null;

            // 1. Check existing target validity
            if (creep.memory.target_deposit_id) {
                target = Game.getObjectById(creep.memory.target_deposit_id);
                if (!target || target.store.getFreeCapacity(RESOURCE_ENERGY) == 0) {
                    target = null;
                    delete creep.memory.target_deposit_id;
                }
            }

            // 2. Find new target if needed
            if (!target) {
                // Calculate incoming energy from other haulers to avoid overcrowding
                var haulers = cache.myCreeps.filter((c) => c.memory.role == 'hauler' && c.memory.target_deposit_id && c.id !== creep.id);
                
                var incomingEnergy = {};
                for(var h of haulers) {
                    if(incomingEnergy[h.memory.target_deposit_id] == undefined) {
                        incomingEnergy[h.memory.target_deposit_id] = 0;
                    }
                    incomingEnergy[h.memory.target_deposit_id] += h.store.getUsedCapacity(RESOURCE_ENERGY);
                }

                //log(`[${creep.name}] Considerations - Incoming: ${JSON.stringify(incomingEnergy)}`);

                var needsEnergy = (structure) => {
                    var incoming = incomingEnergy[structure.id] || 0;
                    return structure.store.getFreeCapacity(RESOURCE_ENERGY) > incoming;
                };

                // Find the closest structure that needs energy.
                // Prioritize Spawn, Extension and Tower
                var towers = (cache.structuresByType[STRUCTURE_TOWER] || []).filter(s => 
                    s.store.getFreeCapacity(RESOURCE_ENERGY) > 200 && needsEnergy(s)
                );
                if (towers.length > 0) {
                    target = creep.pos.findClosestByPath(towers);
                }

                // No need to fill tower yet, find other structures
                if (!target) {
                    var extensions = cache.structuresByType[STRUCTURE_EXTENSION] || [];
                    var spawns = cache.structuresByType[STRUCTURE_SPAWN] || [];
                    var candidates = [...extensions, ...spawns].filter(s => 
                        s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && needsEnergy(s)
                    );
                    if (candidates.length > 0) {
                        target = creep.pos.findClosestByPath(candidates);
                    }
                }

                // If no high priority targets, fill storage
                if (!target) {
                    var storages = cache.structuresByType[STRUCTURE_STORAGE] || [];
                    var candidates = storages.filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
                    if (candidates.length > 0) {
                        target = creep.pos.findClosestByPath(candidates);
                    }
                }

                // Lowest priority but still needed is containers in early game. but it has to be a container within 2 range of spawn
                // OR containers that are 2 range of controller
                if (!target) {
                    var spawns = cache.structuresByType[STRUCTURE_SPAWN] || [];
                    var spawn = spawns.find(s => s.my);
                    if (spawn) {
                        var containers = cache.structuresByType[STRUCTURE_CONTAINER] || [];
                        var candidates = containers.filter(s => 
                            s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 &&
                            (s.pos.inRangeTo(creep.room.controller, 2) || s.pos.inRangeTo(spawn, 2)) &&
                            needsEnergy(s)
                        );
                        if (candidates.length > 0) {
                            target = creep.pos.findClosestByPath(candidates);
                        }
                    }
                }

                if (target) {
                    creep.memory.target_deposit_id = target.id;
                } else {
                    // no target 
                }
            }

            if(target) {
                // Try to transfer energy to the target.
                if(creep.transfer(target, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                    // If not in range, move towards it.
                    creep.memory.moving = true;
                    creep.moveTo(target, {reusePath: 15, range: 1});
                }
            } else {
                // Just move back nearby spawn area and hang around range 3
                creep.moveTo(creep.room.find(FIND_MY_SPAWNS)[0],{reusePath: 15, range:3})
            }
	    }
	    else {
            // STATE: GETTING ENERGY
            let target = null;

            // Check if we have a valid target in memory
            if (creep.memory.target_source_id) {
                target = Game.getObjectById(creep.memory.target_source_id);
                if (!target) {
                    delete creep.memory.target_source_id;
                } else {
                    // Check validity based on type
                    if (target instanceof Resource) {
                        if (target.amount == 0) {
                            target = null;
                            delete creep.memory.target_source_id;
                        }
                    } else { // Structure or Ruin
                        if (target.store.getUsedCapacity(RESOURCE_ENERGY) == 0) {
                            target = null;
                            delete creep.memory.target_source_id;
                        }
                    }
                }
            }

            if (!target) {
                // Calculate targeted energy by other haulers to avoid overcrowding
                var haulers = cache.myCreeps.filter((c) => c.memory.role == 'hauler' && c.memory.target_source_id && c.id !== creep.id);
                
                var targetedEnergy = {};
                for(var h of haulers) {
                    if(targetedEnergy[h.memory.target_source_id] == undefined) {
                        targetedEnergy[h.memory.target_source_id] = 0;
                    }
                    targetedEnergy[h.memory.target_source_id] += h.store.getFreeCapacity(RESOURCE_ENERGY);
                }

                var isTargetValid = (t) => {
                    var reserved = targetedEnergy[t.id] || 0;
                    var amount = 0;
                    if (t instanceof Resource) {
                        amount = t.amount;
                    } else {
                        amount = t.store.getUsedCapacity(RESOURCE_ENERGY);
                    }
                    return amount > reserved;
                };

                // 1. Dropped Resources
                const dropped = cache.dropped.filter(r => r.resourceType == RESOURCE_ENERGY && r.amount > 50 && isTargetValid(r));

                // 2. Ruins
                const ruins = cache.ruins.filter(r => r.store.getUsedCapacity(RESOURCE_ENERGY) > 0 && isTargetValid(r));

                // 3. Tombstones if there is at least worth while energy. 
                const tombstones = creep.room.find(FIND_TOMBSTONES).filter(t => t.store.getUsedCapacity(RESOURCE_ENERGY) > 100 && isTargetValid(t));

                // 4. Structures (Containers & Storage)
                var spawns = cache.structuresByType[STRUCTURE_SPAWN] || [];
                var spawn = spawns.find(s => s.my);
                
                var storages = cache.structuresByType[STRUCTURE_STORAGE] || [];
                var containers = cache.structuresByType[STRUCTURE_CONTAINER] || [];

				const structures = [...storages, ...containers].filter(s => {
				    if (s.structureType == STRUCTURE_STORAGE) {
				        // 1. Calculate how much energy is currently needed by the whole room
				        let totalRoomNeeded = creep.room.energyCapacityAvailable - creep.room.energyAvailable;
				        
				        // 2. Subtract energy already being carried by other haulers to Spawns/Extensions
				        let energySuitsInTransit = cache.myCreeps
				            .filter(c => c.memory.role == 'hauler' && c.memory.working && c.id !== creep.id)
				            .reduce((sum, c) => sum + c.store.getUsedCapacity(RESOURCE_ENERGY), 0);
				
				        // Only pull from storage if the room actually needs more than what is already in transit
				        return (totalRoomNeeded > energySuitsInTransit) && 
				               s.store.getUsedCapacity(RESOURCE_ENERGY) > 0 && isTargetValid(s);
				    }
                    if (s.structureType == STRUCTURE_CONTAINER) {
                        // If container is full, we consider it except for controller's container
                        if ((s.store.getFreeCapacity(RESOURCE_ENERGY) === 0) && !(creep.room.controller && s.pos.inRangeTo(creep.room.controller, 2))) {
                            return isTargetValid(s);
                        }

                        // Exclude controller containers, and spawn containers if strorage doesn't exist
                        if (creep.room.controller && s.pos.inRangeTo(creep.room.controller, 2)) return false;
                        if (spawn && s.pos.inRangeTo(spawn, 2) && !storages) return false;
                        return s.store.getUsedCapacity(RESOURCE_ENERGY) > 0 && isTargetValid(s);
                    }
                    return false;
                });

                // Combine all candidates
                const allTargets = [...dropped, ...ruins, ...tombstones, ...structures];
                
                // Find closest
                target = creep.pos.findClosestByPath(allTargets);

                if (target) {
                    creep.memory.target_source_id = target.id;
                }
            }
            
            if (target) {
                if (target instanceof Resource) {
                    if (creep.pickup(target) == ERR_NOT_IN_RANGE) {
                        creep.memory.moving = true;
                        creep.moveTo(target, {reusePath: 15, range: 1});
                    }
                } else {
                    if (creep.withdraw(target, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                        creep.memory.moving = true;
                        creep.moveTo(target, {reusePath: 15, range: 1});
                    }
                }
            }
	    }
	}
};

module.exports = roleHauler;
