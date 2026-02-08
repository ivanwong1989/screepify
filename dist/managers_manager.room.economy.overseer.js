module.exports = {
    /**
     * The Overseer acts as the "Brain" of the room.
     * It analyzes the environment and sets the high-level State and Goals.
     * It does NOT assign tasks or spawn creeps directly.
     * These are the scope of jobs overseer should look after in a room:
     * - Intel and data for the room, for example creep census, source positions, structures of interest, roads etc, intel that can
     *   help the overseer decide and guide the room
     * - Monitor energy requirements, part throughput and capacity limits. For exam if it detects there's a container right beside the 
     *   energy source, then it knows that it can use a 5 WORK, 1 CARRY, 1 MOVE creep to fulfill the mining need. Overseer does NOT make the 
     *   tasks, however it sees the strategic flow of the room, when to enable static mining + haulers combo, or fall back to normal moving miners etc. 
     * - Monitors for emergency room states like being defensive, or surplus
     * - Monitors for constructions needed if there is too much then guides the room to growth state
     * 
     * @param {Room} room
     */
    run: function(room) {
        // Initialize Brain Memory
        if (!room.memory.brain) {
            room.memory.brain = {
                state: 'STABLE',
                intel: {},
                strategies: {}
            };
        }
        const brain = room.memory.brain;

        // 1. Gather Data (Census & Intel)
        // Update static intel (sources, containers) infrequently
        if (!brain.intel || Game.time % 100 === 0) {
            this.updateIntel(room);
        }
        
        // Update Census (Counts & Body Parts)
        this.performCensus(room);

        const cache = global.getRoomCache(room);
        const creeps = cache.myCreeps || [];
        const hostiles = cache.hostiles || [];
        const sites = cache.constructionSites || [];

        // Check for decaying structures
        const decayingStructures = [
            ...(cache.structuresByType[STRUCTURE_ROAD] || []),
            ...(cache.structuresByType[STRUCTURE_CONTAINER] || []),
            ...(cache.structuresByType[STRUCTURE_RAMPART] || [])
        ].filter(s => {
            if (s.structureType === STRUCTURE_ROAD) return s.hits < s.hitsMax * 0.8;
            if (s.structureType === STRUCTURE_CONTAINER) return s.hits < s.hitsMax * 0.9;
            if (s.structureType === STRUCTURE_RAMPART) return s.hits < 5000; // Baseline
            return false;
        });

        // 2. Analyze Situation
        // Emergency: No creeps and low energy
        const isEmergency = creeps.length === 0;
        const underAttack = hostiles.length > 0;
        const hasConstruction = sites.length > 0;
        const needsRepair = decayingStructures.length > 0;

        // Starvation Check:
        // If we have no storage, and energy is low (< 50%), disable construction to prevent
        // builders from stealing energy needed for spawning harvesters/haulers.
        const energyRatio = room.energyAvailable / room.energyCapacityAvailable;
        const isStarving = !room.storage && energyRatio < 0.5;

        // 3. Determine State
        // Priority: Emergency > Defense > Growth > Stable
        let state = 'STABLE';
        if (isEmergency) state = 'EMERGENCY';
        else if (underAttack) state = 'DEFENSE';
        else if (hasConstruction && !isStarving) state = 'GROWTH';
        console.log(`[Overseer] Room ${room.name} State: ${state}`);

        // 4. Determine Strategies (Mining, etc.)
        this.determineStrategies(room, brain);

        // 5. Publish to Memory (for Tasks and Spawner to read)
        brain.state = state;
        brain.needs = {
            repair: needsRepair,
            build: hasConstruction && !isStarving,
            hostiles: underAttack
        };
        
        // 6. Generate Missions & Population
        this.generateMissions(room);
        console.log(`[Overseer] Missions generated: ${brain.missions ? brain.missions.length : 0}`);
        this.managePopulation(room);

        // Visual Debug
        new RoomVisual(room.name).text(`Brain: ${state}`, 1, 1, {align: 'left', opacity: 0.5});
        this.visualizeStrategies(room);
    },

    updateIntel: function(room) {
        const brain = room.memory.brain;
        const cache = global.getRoomCache(room);
        const sources = room.find(FIND_SOURCES);
        const allContainers = cache.structuresByType[STRUCTURE_CONTAINER] || [];
        const allLinks = cache.structuresByType[STRUCTURE_LINK] || [];
        
        const sourceIntel = {};
        sources.forEach(source => {
            // Check for adjacent containers
            const containers = source.pos.findInRange(allContainers, 1);
            const links = source.pos.findInRange(allLinks, 2);

            sourceIntel[source.id] = {
                pos: source.pos,
                containerId: containers.length > 0 ? containers[0].id : null,
                linkId: links.length > 0 ? links[0].id : null
            };
        });

        // Controller Intel
        let controllerIntel = {};
        if (room.controller) {
            const containers = room.controller.pos.findInRange(allContainers, 3);
            const links = room.controller.pos.findInRange(allLinks, 3);
            controllerIntel = {
                pos: room.controller.pos,
                containerId: containers.length > 0 ? containers[0].id : null,
                linkId: links.length > 0 ? links[0].id : null
            };
        }

        brain.intel = {
            sources: sourceIntel,
            controller: controllerIntel,
            lastScan: Game.time
        };
    },

    performCensus: function(room) {
        const brain = room.memory.brain;
        const creeps = global.getRoomCache(room).myCreeps || [];
        
        const census = {
            total: creeps.length,
            roles: {},
            bodyParts: {
                [WORK]: 0,
                [CARRY]: 0,
                [MOVE]: 0
            }
        };

        creeps.forEach(c => {
            const role = c.memory.role || 'unknown';
            census.roles[role] = (census.roles[role] || 0) + 1;
            c.body.forEach(part => {
                if (census.bodyParts[part.type] !== undefined) {
                    census.bodyParts[part.type]++;
                }
            });
        });

        brain.census = census;
    },

    determineStrategies: function(room, brain) {
        if (!brain.strategies) brain.strategies = {};
        const intel = brain.intel || {};
        const sourceIntel = intel.sources || {};

        // Mining Strategy
        const miningStrategy = {};
        for (const sourceId in sourceIntel) {
            const info = sourceIntel[sourceId];
            if (info.containerId || info.linkId) {
                // Static mining possible
                miningStrategy[sourceId] = {
                    mode: 'static',
                    containerId: info.containerId,
                    linkId: info.linkId,
                    // 5 WORK parts deplete a source (3000/300 = 10 energy/tick. 5*2 = 10).
                    requiredParts: [WORK, WORK, WORK, WORK, WORK, MOVE] 
                };
            } else {
                // Mobile/Universal mining
                miningStrategy[sourceId] = {
                    mode: 'mobile',
                    requiredParts: [WORK, CARRY, MOVE] 
                };
            }
        }
        brain.strategies.mining = miningStrategy;

        // Calculate Limits
        const sourceCount = Object.keys(sourceIntel).length;
        // 5 WORK parts per source to saturate (10 energy/tick)
        // Buffer for travel/upgrading (1.5x)
        const saturationLimit = sourceCount * 5;
        const bufferMultiplier = 1.5; 
        
        brain.limits = {
            maxWorkParts: Math.ceil(saturationLimit * bufferMultiplier),
            maxCreeps: 20 
        };
    },

    visualizeStrategies: function(room) {
        const brain = room.memory.brain;
        if (!brain || !brain.strategies || !brain.strategies.mining) return;
        
        const mining = brain.strategies.mining;
        for (const id in mining) {
            const strat = mining[id];
            const source = Game.getObjectById(id);
            if (source) {
                new RoomVisual(room.name).text(
                    `⛏️ ${strat.mode}`, 
                    source.pos.x, 
                    source.pos.y - 2, 
                    {align: 'center', font: 0.4, color: strat.mode === 'static' ? '#00ff00' : '#ffff00'}
                );
            }
        }
    },

    generateMissions: function(room) {
        const brain = room.memory.brain;
        const missions = [];
        const cache = global.getRoomCache(room);
        
        // 1. Economy & Logistics Missions
        // Mining: Check strategies and current saturation
        const miningStrategies = brain.strategies.mining || {};
        for (const sourceId in miningStrategies) {
            const strategy = miningStrategies[sourceId];
            const source = Game.getObjectById(sourceId);
            // Only create mission if source exists and has energy
            if (source && source.energy > 0) {
                // Monitor WORK parts assigned to this source
                const assignedMiners = (cache.myCreeps || []).filter(c => 
                    c.memory.taskData && 
                    c.memory.taskData.targetId === sourceId && 
                    c.memory.taskData.action === 'harvest'
                );
                const currentWork = assignedMiners.reduce((sum, c) => sum + c.getActiveBodyparts(WORK), 0);
                
                missions.push({
                    type: 'MINING',
                    priority: 10,
                    data: {
                        sourceId: sourceId,
                        mode: strategy.mode,
                        containerId: strategy.containerId,
                        currentWork: currentWork,
                        targetWork: 5 // Standard saturation
                    }
                });
            }
        }

        // Refill: High priority if energy is needed
        if (room.energyAvailable < room.energyCapacityAvailable) {
            missions.push({
                type: 'REFILL',
                priority: 100,
                data: {
                    amount: room.energyCapacityAvailable - room.energyAvailable
                }
            });
        }

        // Logistics: Check containers > 50% or dropped energy
        const containers = room.find(FIND_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_CONTAINER && s.store.getUsedCapacity(RESOURCE_ENERGY) > s.store.getCapacity(RESOURCE_ENERGY) * 0.5
        });
        const dropped = room.find(FIND_DROPPED_RESOURCES, { filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 100 });
        
        if (containers.length > 0 || dropped.length > 0) {
            missions.push({
                type: 'LOGISTICS',
                priority: 50,
                data: {
                    containerIds: containers.map(c => c.id),
                    droppedIds: dropped.map(d => d.id)
                }
            });
        }

        // 2. Infrastructure & Progress Missions
        // Upgrade: Check downgrade timer or surplus
        const storageSurplus = room.storage && room.storage.store[RESOURCE_ENERGY] > 50000;
        const downgradeCritical = room.controller.ticksToDowngrade < 5000;
        
        if (downgradeCritical || storageSurplus) {
            missions.push({
                type: 'UPGRADE',
                priority: downgradeCritical ? 90 : 20,
                data: {
                    targetId: room.controller.id,
                    intensity: storageSurplus ? 'high' : 'maintenance'
                }
            });
        }

        // Build: If sites exist
        if (brain.needs.build) {
            missions.push({
                type: 'BUILD',
                priority: 30,
                data: {}
            });
        }

        // Repair: If structures are decaying
        if (brain.needs.repair) {
            missions.push({
                type: 'REPAIR',
                priority: 40,
                data: {}
            });
        }

        brain.missions = missions;
    },

    managePopulation: function(room) {
        const brain = room.memory.brain;
        const creeps = global.getRoomCache(room).myCreeps || [];
        // Filter out creeps about to die (TTL < 100) to trigger pre-spawning
        const validCreeps = creeps.filter(c => (c.ticksToLive || 1500) > 100);
        
        const roleCounts = {};
        validCreeps.forEach(c => {
            const role = c.memory.role || 'unknown';
            roleCounts[role] = (roleCounts[role] || 0) + 1;
        });

        const missions = brain.missions || [];
        const spawnRequests = [];

        // Map Missions to Roles and Desired Counts
        const miningMissions = missions.filter(m => m.type === 'MINING');
        const staticMinersNeeded = miningMissions.filter(m => m.data.mode === 'static').length;
        
        // Calculate mobile miners based on expected body size (RCL1 = 1 WORK, RCL2+ = 2 WORK)
        // We cap mobile miner requirements at 2 WORK parts in the switch below, so max 2 WORK per creep.
        const workPerMobileMiner = room.energyCapacityAvailable <= 300 ? 1 : 2;
        const mobileMinersPerSource = Math.ceil(5 / workPerMobileMiner);
        const mobileMinersNeeded = miningMissions.filter(m => m.data.mode === 'mobile').length * mobileMinersPerSource;

        const desired = {
            miner: staticMinersNeeded,
            mobile_miner: mobileMinersNeeded,
            hauler: missions.some(m => m.type === 'LOGISTICS' || m.type === 'REFILL') ? 2 : 0,
            upgrader: missions.some(m => m.type === 'UPGRADE') ? (missions.find(m => m.type === 'UPGRADE').data.intensity === 'high' ? 3 : 1) : 0,
            builder: missions.some(m => m.type === 'BUILD') ? Math.min(3, Math.ceil((global.getRoomCache(room).constructionSites || []).length / 2)) : 0,
            repairer: missions.some(m => m.type === 'REPAIR') ? 1 : 0
        };

        // Generate Spawn Requests
        for (const role in desired) {
            if ((roleCounts[role] || 0) < desired[role]) {
                let requirements = {};
                let priority = 10;

                switch (role) {
                    case 'miner':
                        // 5 WORK, 1 CARRY, 3 MOVE (Standard static miner)
                        requirements = { [WORK]: 5, [CARRY]: 1, [MOVE]: 3 };
                        priority = 100;
                        break;
                    case 'mobile_miner':
                        // Balanced for mining and carrying
                        requirements = { [WORK]: 2, [CARRY]: 2, [MOVE]: 2 };
                        priority = 90;
                        break;
                    case 'hauler':
                        // 10 CARRY, 5 MOVE (Standard hauler)
                        requirements = { [CARRY]: 10, [MOVE]: 5 };
                        priority = 50;
                        break;
                    case 'upgrader':
                        const highIntensity = missions.some(m => m.type === 'UPGRADE' && m.data.intensity === 'high');
                        requirements = highIntensity ? { [WORK]: 10, [CARRY]: 2, [MOVE]: 6 } : { [WORK]: 2, [CARRY]: 1, [MOVE]: 1 };
                        priority = 20;
                        break;
                    case 'builder':
                        requirements = { [WORK]: 4, [CARRY]: 4, [MOVE]: 4 };
                        priority = 30;
                        break;
                    case 'repairer':
                        requirements = { [WORK]: 2, [CARRY]: 2, [MOVE]: 2 };
                        priority = 40;
                        break;
                    default:
                        requirements = { [WORK]: 1, [CARRY]: 1, [MOVE]: 1 };
                        break;
                }

                spawnRequests.push({
                    role: role,
                    priority: priority,
                    requirements: requirements
                });
            }
        }
        brain.spawnRequests = spawnRequests;
    }
};
