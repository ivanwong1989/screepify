module.exports = {
    /**
     * The Task Manager reads the Overseer's State and generates specific Missions.
     * It then assigns these missions to available creeps.
     * 
     * @param {Room} room
     */
    run: function(room) {
        if (!room.memory.brain) return;
        const state = room.memory.brain.state;
        const brainMissions = room.memory.brain.missions || [];
        console.log(`[Tasks] Running for ${room.name}. Brain Missions: ${brainMissions.length}`);
        
        // 1. Generate Missions based on State/Reality
        // Translate Brain Missions (Strategy) into Actionable Tasks (Tactics)
        const tasks = this.resolveTasks(room, brainMissions);
        console.log(`[Tasks] Resolved actionable tasks: ${tasks.length}`);
        
        // 2. Assign Missions to Creeps
        const creeps = global.getRoomCache(room).myCreeps || [];
        
        creeps.forEach(creep => {
            // State Hysteresis: Update working state before checking assignments
            const hasEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
            const isFull = creep.store.getFreeCapacity() === 0;
            
            if (isFull) creep.memory.working = true;
            if (!hasEnergy) creep.memory.working = false;
            const working = creep.memory.working;

            // If creep has a valid mission, skip
            if (creep.memory.missionId) {
                const existingTask = tasks.find(t => t.id === creep.memory.missionId);
                // Check if task is still valid AND compatible with current state (Work vs Gather)
                const isCompatible = existingTask && (working ? existingTask.type === 'work' : existingTask.type === 'gather');
                
                if (existingTask && isCompatible) {
                    existingTask.assigned = (existingTask.assigned || 0) + 1;
                    creep.memory.taskData = existingTask.data;
                    return;
                } else {
                    console.log(`[Tasks] Creep ${creep.name} mission ${creep.memory.missionId} invalid or incompatible.`);
                }
            }

            // Find suitable mission
            const task = this.findTaskForCreep(creep, tasks);
            if (task) {
                console.log(`[Tasks] Assigning ${task.id} to ${creep.name}`);
                creep.memory.missionId = task.id;
                creep.memory.taskData = task.data; // The "Mission Sheet" for the dumb creep
                // Mark mission as assigned (simple round-robin prevention)
                task.assigned = (task.assigned || 0) + 1;
            } else {
                console.log(`[Tasks] No task found for ${creep.name} (Role: ${creep.memory.role})`);
                delete creep.memory.missionId;
                delete creep.memory.taskData;
            }
        });

        // Debug: Task Summary
        if (Memory.debug) {
            console.log(`[Tasks] Generated ${tasks.length} tasks from ${brainMissions.length} strategies.`);
        }
    },

    /**
     * Translates high-level Brain Missions into specific Actionable Tasks.
     * Returns an array of task objects.
     */
    resolveTasks: function(room, brainMissions) {
        const tasks = [];
        const brain = room.memory.brain;
        const cache = global.getRoomCache(room);

        brainMissions.forEach(mission => {
            // 1. MINING -> Harvest Tasks
            if (mission.type === 'MINING') {
                const isMobile = mission.data.mode === 'mobile';
                tasks.push({
                    id: `mine_${mission.data.sourceId}`,
                    type: 'gather',
                    priority: mission.priority,
                    role: isMobile ? 'mobile_miner' : 'miner', // Preferred role
                    limit: isMobile ? 5 : 3, // Max miners per source (usually 1 if static, more if mobile)
                    data: {
                        action: 'harvest',
                        targetId: mission.data.sourceId,
                        containerId: mission.data.containerId // Optional: stand here
                    }
                });
            }

            // 2. REFILL -> Transfer Tasks (Spawns/Extensions)
            if (mission.type === 'REFILL') {
                const targets = [...(cache.structuresByType[STRUCTURE_SPAWN] || []), ...(cache.structuresByType[STRUCTURE_EXTENSION] || [])]
                    .filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
                
                targets.forEach(t => {
                    // Hauler Task
                    tasks.push({
                        id: `refill_${t.id}`,
                        type: 'work',
                        priority: mission.priority,
                        role: 'hauler',
                        limit: 1,
                        data: {
                            action: 'transfer',
                            targetId: t.id,
                            resourceType: RESOURCE_ENERGY
                        }
                    });

                    // Mobile Miner Task
                    tasks.push({
                        id: `refill_mobile_${t.id}`,
                        type: 'work',
                        priority: mission.priority,
                        role: 'mobile_miner',
                        limit: 1,
                        data: {
                            action: 'transfer',
                            targetId: t.id,
                            resourceType: RESOURCE_ENERGY
                        }
                    });
                });
            }

            // 3. LOGISTICS -> Withdraw/Pickup Tasks AND Transfer to Storage
            if (mission.type === 'LOGISTICS') {
                // Gather from Containers
                (mission.data.containerIds || []).forEach(id => {
                    tasks.push({
                        id: `withdraw_${id}`,
                        type: 'gather',
                        priority: mission.priority,
                        role: 'hauler',
                        limit: 2,
                        data: {
                            action: 'withdraw',
                            targetId: id,
                            resourceType: RESOURCE_ENERGY
                        }
                    });
                });

                // Pickup Dropped
                (mission.data.droppedIds || []).forEach(id => {
                    tasks.push({
                        id: `pickup_${id}`,
                        type: 'gather',
                        priority: mission.priority + 5, // Slightly higher than withdraw
                        role: 'hauler',
                        limit: 1,
                        data: {
                            action: 'pickup',
                            targetId: id
                        }
                    });
                });

                // Implicit: If we have logistics, we likely want to dump into Storage if not Refilling
                if (room.storage && room.storage.store.getFreeCapacity() > 0) {
                    tasks.push({
                        id: `store_${room.storage.id}`,
                        type: 'work',
                        priority: mission.priority - 10, // Lower than Refill
                        role: 'hauler',
                        limit: 5,
                        data: {
                            action: 'transfer',
                            targetId: room.storage.id,
                            resourceType: RESOURCE_ENERGY
                        }
                    });
                }
            }

            // 4. UPGRADE -> Upgrade Task
            if (mission.type === 'UPGRADE') {
                tasks.push({
                    id: `upgrade_${mission.data.targetId}`,
                    type: 'work',
                    priority: mission.priority,
                    role: 'upgrader',
                    limit: mission.data.intensity === 'high' ? 5 : 1,
                    data: {
                        action: 'upgrade',
                        targetId: mission.data.targetId
                    }
                });

                // Mobile Miner Upgrade Task (Fallback if no refill needed)
                tasks.push({
                    id: `upgrade_mobile_${mission.data.targetId}`,
                    type: 'work',
                    priority: mission.priority - 5,
                    role: 'mobile_miner',
                    limit: 5,
                    data: {
                        action: 'upgrade',
                        targetId: mission.data.targetId
                    }
                });
            }

            // 5. BUILD -> Build Tasks
            if (mission.type === 'BUILD') {
                const sites = room.find(FIND_CONSTRUCTION_SITES);
                sites.forEach(site => {
                    tasks.push({
                        id: `build_${site.id}`,
                        type: 'work',
                        priority: mission.priority,
                        role: 'builder',
                        limit: 3,
                        data: {
                            action: 'build',
                            targetId: site.id
                        }
                    });
                });

                // Generate gather tasks for builders if there is work to do
                if (sites.length > 0) {
                    // 1. Withdraw from Storage
                    if (room.storage && room.storage.store[RESOURCE_ENERGY] > 0) {
                        tasks.push({
                            id: `build_withdraw_storage`,
                            type: 'gather',
                            priority: mission.priority,
                            role: 'builder',
                            limit: 10,
                            data: {
                                action: 'withdraw',
                                targetId: room.storage.id,
                                resourceType: RESOURCE_ENERGY
                            }
                        });
                    }

                    // 2. Withdraw from Containers
                    const containers = (cache.structuresByType[STRUCTURE_CONTAINER] || [])
                        .filter(c => c.store[RESOURCE_ENERGY] > 0);
                    
                    containers.forEach(c => {
                        tasks.push({
                            id: `build_withdraw_${c.id}`,
                            type: 'gather',
                            priority: mission.priority,
                            role: 'builder',
                            limit: 3,
                            data: {
                                action: 'withdraw',
                                targetId: c.id,
                                resourceType: RESOURCE_ENERGY
                            }
                        });
                    });

                    // 3. Withdraw from Spawn (Fallback if no storage/containers)
                    const hasStorage = !!room.storage;
                    const hasContainers = (cache.structuresByType[STRUCTURE_CONTAINER] || []).length > 0;

                    if (!hasStorage && !hasContainers) {
                        const spawns = (cache.structuresByType[STRUCTURE_SPAWN] || [])
                            .filter(s => s.store[RESOURCE_ENERGY] > 0);

                        spawns.forEach(s => {
                            tasks.push({
                                id: `build_withdraw_${s.id}`,
                                type: 'gather',
                                priority: mission.priority,
                                role: 'builder',
                                limit: 3,
                                data: {
                                    action: 'withdraw',
                                    targetId: s.id,
                                    resourceType: RESOURCE_ENERGY
                                }
                            });
                        });
                    }
                }
            }

            // 6. REPAIR -> Repair Tasks
            if (mission.type === 'REPAIR') {
                // Re-scan for damaged structures (or use cached/intel if available)
                // For simplicity, we scan here or rely on what triggered the mission
                const damaged = room.find(FIND_STRUCTURES, {
                    filter: s => s.hits < s.hitsMax * 0.8 && s.structureType !== STRUCTURE_WALL
                });
                damaged.forEach(s => {
                    tasks.push({
                        id: `repair_${s.id}`,
                        type: 'work',
                        priority: mission.priority,
                        role: 'repairer',
                        limit: 1,
                        data: {
                            action: 'repair',
                            targetId: s.id
                        }
                    });
                });

                // Generate gather tasks for repairers if there is work to do
                if (damaged.length > 0) {
                    // 1. Withdraw from Storage
                    if (room.storage && room.storage.store[RESOURCE_ENERGY] > 0) {
                        tasks.push({
                            id: `repair_withdraw_storage`,
                            type: 'gather',
                            priority: mission.priority,
                            role: 'repairer',
                            limit: 10,
                            data: {
                                action: 'withdraw',
                                targetId: room.storage.id,
                                resourceType: RESOURCE_ENERGY
                            }
                        });
                    }

                    // 2. Withdraw from Containers
                    const containers = (cache.structuresByType[STRUCTURE_CONTAINER] || [])
                        .filter(c => c.store[RESOURCE_ENERGY] > 0);
                    
                    containers.forEach(c => {
                        tasks.push({
                            id: `repair_withdraw_${c.id}`,
                            type: 'gather',
                            priority: mission.priority,
                            role: 'repairer',
                            limit: 3,
                            data: {
                                action: 'withdraw',
                                targetId: c.id,
                                resourceType: RESOURCE_ENERGY
                            }
                        });
                    });
                }
            }
        });

        return tasks;
    },

    findTaskForCreep: function(creep, tasks) {
        const role = creep.memory.role;
        const working = creep.memory.working;
        console.log(`[Tasks] Finding task for ${creep.name}. Role: ${role}, Working: ${working}, Energy: ${creep.store.getUsedCapacity(RESOURCE_ENERGY)}`);

        // Filter tasks by Role and Type (Gather vs Work)
        let candidates = tasks.filter(t => {
            // Role Check: Exact match OR Universal fallback
            const roleMatch = t.role === role || role === 'universal';
            
            // Type Check
            const typeMatch = working ? t.type === 'work' : t.type === 'gather';
            
            return roleMatch && typeMatch;
        });
        console.log(`[Tasks] Candidates for ${creep.name}: ${candidates.length}`);
        
        // Sort by Priority (descending) then Assignment Count (ascending)
        candidates.sort((a, b) => {
            if (b.priority !== a.priority) return b.priority - a.priority;
            return (a.assigned || 0) - (b.assigned || 0); 
        });
        
        // Return best available task
        const best = candidates[0];
        if (best && (best.assigned || 0) < (best.limit || 1)) {
            return best;
        }
        return null;
    }
};
