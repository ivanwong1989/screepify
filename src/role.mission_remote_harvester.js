var roleMissionRemoteHarvester = {
    run: function(creep) {
        const cache = global.getRoomCache(creep.room);
        if (creep.memory.working && creep.store.getUsedCapacity() === 0) {
            creep.memory.working = false;
            creep.say('🔄 harvest');
        }
        if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
            creep.memory.working = true;
            creep.say('🚧 work');
        }

        // If we just entered a new room, step off the exit first
        const currentRoom = creep.room;
        const onExit = creep.pos.x === 0 || creep.pos.x === 49 || creep.pos.y === 0 || creep.pos.y === 49;
        if (creep.memory.currentRoom !== currentRoom.name) {
            creep.memory.currentRoom = currentRoom.name;
            creep.memory.justArrived = true;
        }

        if (creep.memory.justArrived) {
            if (onExit) {
                if (creep.pos.x === 0) creep.move(RIGHT);
                else if (creep.pos.x === 49) creep.move(LEFT);
                else if (creep.pos.y === 0) creep.move(BOTTOM);
                else if (creep.pos.y === 49) creep.move(TOP);
                else creep.moveTo(new RoomPosition(25, 25, currentRoom.name), {visualizePathStyle: {stroke: '#ffffff'}, reusePath: 0, maxRooms: 1, range: 1});
                return;
            } else {
                creep.memory.justArrived = false;
            }
        }

        if (!creep.memory.working) {
            // STATE: HARVESTING
            if (creep.room.name !== creep.memory.targetRoom) {
                let targetPos = new RoomPosition(25, 25, creep.memory.targetRoom);

                // Use cached source position if available for better pathing
                if (Memory.remoteRooms && Memory.remoteRooms[creep.memory.targetRoom]) {
                    const rMem = Memory.remoteRooms[creep.memory.targetRoom];
                    if (rMem.sources && rMem.sourcePositions) {
                        const idx = rMem.sources.indexOf(creep.memory.targetSourceId);
                        if (idx !== -1 && rMem.sourcePositions[idx]) {
                            targetPos = new RoomPosition(rMem.sourcePositions[idx].x, rMem.sourcePositions[idx].y, creep.memory.targetRoom);
                        }
                    }
                }

                log(`[${creep.name}] Moving to target room ${creep.memory.targetRoom}`);
                creep.moveTo(targetPos, {visualizePathStyle: {stroke: '#ffaa00'}, reusePath: 20, range: 1});
                return;
            }

            let source = Game.getObjectById(creep.memory.targetSourceId);
            if (source) {
                if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(source, {visualizePathStyle: {stroke: '#ffaa00'}, maxRooms:1, range: 1});
                }
            } else {
                log(`[${creep.name}] Source ${creep.memory.targetSourceId} not found in room ${creep.room.name}`);
            }
        } else {
            // STATE: WORKING (Full)
            let didLocalWork = false;

            if (creep.room.name === creep.memory.targetRoom) {
                let source = Game.getObjectById(creep.memory.targetSourceId);
                if (source) {
                    // Priority 1: Build Container in range 2 or build constructions sites
                    const sites = cache.constructionSites || [];
                    let site = sites.find(s => s.structureType === STRUCTURE_CONTAINER && s.pos.inRangeTo(source, 2));

                    if (!site) {
                        site = sites.find(s => s.pos.inRangeTo(source, 3));
                    }

                    if (site) {
                        log(`[${creep.name}] Building site at ${site.pos}`);
                        if (creep.build(site) === ERR_NOT_IN_RANGE) {
                            creep.moveTo(site, {visualizePathStyle: {stroke: '#ffffff'}, range: 1});
                        }
                        didLocalWork = true;
                    }

                    // Priority 2: Repair Container in range 2
                    if (!didLocalWork) {
                        const containers = cache.structuresByType[STRUCTURE_CONTAINER] || [];
                        let container = containers.find(s => s.pos.inRangeTo(source, 2));

                        if (container && container.hits < container.hitsMax) {
                            log(`[${creep.name}] Repairing container at ${container.pos}`);
                            if (creep.repair(container) === ERR_NOT_IN_RANGE) {
                                creep.moveTo(container, {visualizePathStyle: {stroke: '#ffffff'}, range: 1});
                            }
                            didLocalWork = true;
                        }

                        // Priority 3: Transfer to Container
                        if (!didLocalWork && container && container.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                            log(`[${creep.name}] Transferring to container at ${container.pos}`);
                            if (creep.transfer(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                                creep.moveTo(container, {visualizePathStyle: {stroke: '#ffffff'}, range: 1});
                            }
                            didLocalWork = true;
                        }
                        
                        // As long as there is a container 2 range of assigned source, should not simply head back home even
                        // if that container is empty. just wait. local work has been done in a sense
                        if (container) {
                            didLocalWork = true;
                        }
                    } 
                }
            }

            if (!didLocalWork) {
                // Priority 4: Deliver Home (Fallback if no container or container full)
                if (creep.room.name !== creep.memory.homeRoom) {
                    log(`[${creep.name}] Moving home to ${creep.memory.homeRoom}`);
                    const homePos = new RoomPosition(25, 25, creep.memory.homeRoom);
                    creep.moveTo(homePos, {visualizePathStyle: {stroke: '#00ff00'}, range: 1});
                } else {
                    let home = Game.rooms[creep.memory.homeRoom];
                    let target = null;
                    
                    if (home) {
                        if (home.storage) {
                            target = home.storage;
                        } else {
                            target = home.find(FIND_MY_SPAWNS)[0];
                        }
                    }

                    if (target) {
                        log(`[${creep.name}] Delivering home to ${target.structureType}`);
                        if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                            creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}, range: 1});
                        }
                    } else {
                        log(`[${creep.name}] No home target found`);
                    }
                }
            }
        }
    }
};

module.exports = roleMissionRemoteHarvester;
