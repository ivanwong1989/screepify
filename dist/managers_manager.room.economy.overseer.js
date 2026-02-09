var managerSpawner = require('./managers_manager.room.economy.spawner');

/**
 * The Overseer acts as the "Brain" of the room.
 * It analyzes the environment and sets the high-level State and Goals.
 * It does NOT assign tasks or spawn creeps directly.
 * These are the scope of jobs overseer should look after in a room:
 * - Intel and data for the room, for example creep census, source positions, structures of interest, roads etc, intel that can
 *   help the overseer decide and guide the room
 * - Monitor energy requirements, part throughput and capacity limits. For example if it detects there's a container right beside the 
 *   energy source, then it knows it can use static harvesters paired with haulers. 
 * - Overseer does NOT make the lower level tasks and tracking creep states, however it sees the strategic flow of the room, 
 *   when to enable missions for static mining + haulers combo, or fall back to normal moving miners. Do we need a to refill the extensions or
 *   spawns, is it a good time to upgrade controller. etc. 
 * - Monitors for emergency room states like being defensive, or surplus, and creates those missions accordingly to be consumed by tasker
 * - Monitors for constructions needed if there is too much then guides the room to have builders etc
 * - Overseer specifies the requirement of the work for example i want 10 energy/tick extraction here on this source, or i want 20 hits/tick construction on here
 *   this requirement will be sent to spawner.
 * - Overseer sets the mission priority. 
 * - There should be a common mission interface agreed by overseer, tasker and spawner. This is akin to a contract that get's written by overseer, and 
 *   consumed by tasker and spawner. 
 */
var managerOverseer = {
    /**
     * Main run loop for the Overseer.
     * @param {Room} room
     */
    run: function(room) {
        // 1. Gather Intel
        const intel = this.gatherIntel(room);

        // 2. Determine Room State
        const state = this.determineState(room, intel);

        // 3. Generate Missions
        const missions = this.generateMissions(room, intel, state);

        // 4. Analyze Census (Match Creeps to Missions)
        this.analyzeCensus(missions, intel.myCreeps);

        // 4.5 Reassign Workers (Optimize assignments)
        this.reassignWorkers(room, missions, intel);

        // 5. Publish Missions (Contract for Tasker and Spawner)
        // We attach this to the room object for the current tick.
        // Tasker will read this to assign creeps.
        // Spawner will read this to queue creeps.
        room._missions = missions;
        room._state = state;

        // Publish to Memory
        if (!room.memory.overseer) room.memory.overseer = {};
        room.memory.overseer.missions = missions;
        room.memory.overseer.state = state;

        if (Memory.debug) {
            this.visualize(room, missions, state);
        }
    },

    /**
     * Analyzes the room to gather necessary data.
     * @param {Room} room 
     */
    gatherIntel: function(room) {
        const cache = global.getRoomCache(room);
        const terrain = room.getTerrain();
        
        // Analyze Sources
        const sources = room.find(FIND_SOURCES).map(source => {
            // Check for nearby containers (static mining enablers)
            const containers = source.pos.findInRange(FIND_STRUCTURES, 1, {
                filter: s => s.structureType === STRUCTURE_CONTAINER
            });

            let availableSpaces = 0;
            for (let x = -1; x <= 1; x++) {
                for (let y = -1; y <= 1; y++) {
                    if (x === 0 && y === 0) continue;
                    const t = terrain.get(source.pos.x + x, source.pos.y + y);
                    if (t !== TERRAIN_MASK_WALL) {
                        availableSpaces++;
                    }
                }
            }

            return {
                id: source.id,
                pos: source.pos,
                energy: source.energy,
                energyCapacity: source.energyCapacity,
                hasContainer: containers.length > 0,
                containerId: containers.length > 0 ? containers[0].id : null,
                availableSpaces: availableSpaces
            };
        });

        let controllerSpaces = 0;
        if (room.controller) {
            for (let x = -1; x <= 1; x++) {
                for (let y = -1; y <= 1; y++) {
                    if (x === 0 && y === 0) continue;
                    const t = terrain.get(room.controller.pos.x + x, room.controller.pos.y + y);
                    if (t !== TERRAIN_MASK_WALL) {
                        controllerSpaces++;
                    }
                }
            }
        }

        return {
            sources: sources,
            myCreeps: cache.myCreeps || [],
            constructionSites: cache.constructionSites || [],
            structures: cache.structuresByType || {},
            controller: room.controller,
            availableControllerSpaces: controllerSpaces,
            energyAvailable: room.energyAvailable,
            energyCapacityAvailable: room.energyCapacityAvailable
        };
    },

    /**
     * Determines the high-level state of the room.
     * @param {Room} room 
     * @param {Object} intel 
     */
    determineState: function(room, intel) {
        // Emergency: No creeps or very low energy and low population
        if (intel.myCreeps.length === 0 || (intel.energyAvailable < 300 && intel.myCreeps.length < 2)) {
            return 'EMERGENCY';
        }
        
        // Defcon? (Not implemented yet, but placeholder)
        if (room.find(FIND_HOSTILE_CREEPS).length > 0) {
            return 'DEFENSE';
        }

        return 'NORMAL';
    },

    /**
     * Generates a list of missions based on intel and state.
     * @param {Room} room 
     * @param {Object} intel 
     * @param {String} state 
     */
    generateMissions: function(room, intel, state) {
        const missions = [];
        
        // Define budget for body part calculation
        let budget = intel.energyCapacityAvailable;
        if (state === 'EMERGENCY') {
            budget = Math.max(intel.energyAvailable, 300);
        }
        
        // Group creeps by mission for census feedback
        const creepsByMission = _.groupBy(intel.myCreeps, c => c.memory.missionName);
        
        const getMissionCensus = (name) => {
            const creeps = creepsByMission[name] || [];
            return {
                count: creeps.length,
                work: creeps.reduce((sum, c) => sum + c.getActiveBodyparts(WORK), 0),
                carry: creeps.reduce((sum, c) => sum + c.getActiveBodyparts(CARRY), 0)
            };
        };

        // --- Priority 1: Survival (Emergency) ---
        // If emergency, we might want to suppress other missions or boost priority of harvesting
        const isEmergency = state === 'EMERGENCY';

        // Check for sufficient haulers to enable drop mining
        // We consider creeps with 'logistics' in their mission name or just general haulers
        const logisticsCreeps = intel.myCreeps.filter(c => 
            c.memory.missionName && c.memory.missionName.includes('logistics')
        );
        const haulerCapacity = logisticsCreeps.reduce((sum, c) => sum + c.store.getCapacity(RESOURCE_ENERGY), 0);
        
        // Track available capacity for enabling drop mining per source
        let availableHaulerCapacity = haulerCapacity;

        if (Memory.debug) {
            console.log(`[Overseer Debug] Hauler check: capacity=${haulerCapacity}`);
        }

        // Check if we should enable haulers based on harvester efficiency
        // Haulers are needed only when harvesters are leveled up enough so that their count needs are less than available spaces.
        const potentialHarvester = managerSpawner.checkBody('miner', budget);
        const potentialWork = potentialHarvester.work || 1;
        if (Memory.debug) {
            console.log(`[Overseer Debug] Harvester efficiency check: potentialWork=${potentialWork} (budget: ${budget})`);
        }
        
        const efficientSources = new Set();
        intel.sources.forEach(s => {
            const needed = Math.ceil(5 / potentialWork);
            // We enable haulers if we have the tech (budget > 300), or a container exists, 
            // or if we somehow already have a fleet (e.g. from previous state)
            const isEfficientCheck = needed <= s.availableSpaces && (budget > 300 || s.hasContainer || haulerCapacity > 0);
            // Only enable haulers if we have a container or better than basic RCL1 tech (budget > 300)
            if (isEfficientCheck) {
                efficientSources.add(s.id);
            }
            if (Memory.debug) {
                console.log(`[Overseer Debug] Source ${s.id}: needed=${needed}, availableSpaces=${s.availableSpaces}, hasContainer=${s.hasContainer}, budget=${budget}`);
                console.log(`[Overseer Debug] Source ${s.id}: isEfficientCheck=${isEfficientCheck}`);
            }
        });
        const enableHaulers = efficientSources.size > 0;
        if (Memory.debug) {
            console.log(`[Overseer Debug] enableHaulers=${enableHaulers} (efficientSources: ${efficientSources.size})`);
        }

        // --- Priority 2: Economy (Harvesting) ---
        intel.sources.forEach(source => {
            // Standard Source: 3000 energy / 300 ticks = 10 energy/tick.
            // We want to request enough workforce to meet this (5 WORK parts).
            
            // Determine if we can drop mine (Static Mining)
            // Allowed if we have a container OR if we have enough haulers to pick up dropped energy
            // AND if we are efficient enough to justify haulers (or have them enabled)
            const isEfficient = efficientSources.has(source.id);
            
            // Check if we have capacity specifically for this source
            const neededCap = 300;
            const hasCap = availableHaulerCapacity >= neededCap;
            
            const canDropMine = (source.hasContainer || hasCap) && isEfficient;
            
            // If we are drop mining (and relying on haulers, not container), reserve the capacity
            if (canDropMine && !source.hasContainer) {
                availableHaulerCapacity -= neededCap;
            }

            if (Memory.debug) {
                console.log(`[Overseer Debug] Harvest mission for ${source.id}: isEfficient=${isEfficient}, canDropMine=${canDropMine} (hasContainer: ${source.hasContainer}, hasCap: ${hasCap})`);
            }
            const missionName = `harvest:${source.id}`;
            const archetype = 'miner';
            
            // Census Feedback
            const census = getMissionCensus(missionName);
            const archStats = managerSpawner.checkBody('miner', budget);
            
            const targetWork = 5;
            const deficit = Math.max(0, targetWork - census.work);
            // Calculate how many NEW creeps of current capability are needed to fill deficit
            const neededNew = Math.ceil(deficit / (archStats.work || 1));
            let reqCount = census.count + neededNew;
            
            // Cap at available spaces
            reqCount = Math.min(reqCount, source.availableSpaces);
            if (reqCount === 0 && targetWork > 0) reqCount = 1; // Ensure at least one if needed

            missions.push({
                name: missionName,
                type: 'harvest',
                archetype: archetype,
                sourceId: source.id,
                pos: source.pos,
                requirements: {
                    archetype: archetype,
                    count: reqCount
                },
                data: {
                    hasContainer: source.hasContainer,
                    containerId: source.containerId,
                    mode: canDropMine ? 'static' : 'mobile'
                },
                priority: isEmergency ? 1000 : 100
            });
        });

        // --- Priority 3: Logistics (Hauling/Refilling) ---
        // Always maintain a logistics fleet to ensure energy flow.
        // Only enable if we have determined haulers are needed (efficiency met)
        if (enableHaulers) {
            const logisticsName = 'logistics:refill';
            const logCensus = getMissionCensus(logisticsName);
            const logArch = 'hauler';
            const logStats = managerSpawner.checkBody('hauler', budget);
            
            // Dynamic target: 300 cap (6 parts) per source + 200 cap (4 parts) base buffer
            const partsPerSource = 6;
            const baseParts = 4;
            const targetCarry = (intel.sources.length * partsPerSource) + baseParts;
            
            const logDeficit = Math.max(0, targetCarry - logCensus.carry);
            const logNeeded = Math.ceil(logDeficit / (logStats.carry || 1));
            
            missions.push({
                name: logisticsName,
                type: 'transfer',
                archetype: logArch,
                targetType: 'spawn_extension',
                requirements: {
                    archetype: logArch,
                    count: logCensus.count + logNeeded
                },
                priority: isEmergency ? 900 : 90
            });
        }

        // --- Priority 3.1: Logistics (Refill Containers) ---
        const allContainers = intel.structures[STRUCTURE_CONTAINER] || [];
        const miningContainerIds = new Set(intel.sources.map(s => s.containerId).filter(id => id));
        
        const logicalContainers = allContainers.filter(c => 
            !miningContainerIds.has(c.id) && 
            c.store.getFreeCapacity(RESOURCE_ENERGY) > 0
        );

        if (enableHaulers && logicalContainers.length > 0) {
            missions.push({
                name: 'logistics:refill_containers',
                type: 'transfer',
                archetype: 'hauler',
                targetType: 'logical_containers',
                data: {
                    targetIds: logicalContainers.map(c => c.id)
                },
                requirements: {
                    archetype: 'hauler',
                    count: 1
                },
                priority: 50
            });
        }

        // --- Priority 4: Upgrading ---
        if (intel.controller && intel.controller.my && !isEmergency) {
            // Decide upgrade throttle based on economy
            let upgradePriority = 50;
            let desiredWork = 5;

            if (intel.energyAvailable === intel.energyCapacityAvailable) {
                upgradePriority = 80; // Surplus energy, boost upgrade
                desiredWork = 15;
            }

            // If we have construction sites, throttle upgrading to prioritize building
            if (intel.constructionSites.length > 0) {
                desiredWork = 1;
                upgradePriority = 20;
            }

            const upName = 'upgrade:controller';
            const upCensus = getMissionCensus(upName);
            const upArch = 'worker';
            const upStats = managerSpawner.checkBody('worker', budget);
            const upDeficit = Math.max(0, desiredWork - upCensus.work);
            const upNeeded = Math.ceil(upDeficit / (upStats.work || 1));
            let upCount = Math.min(upCensus.count + upNeeded, intel.availableControllerSpaces);

            // If throttling, cap the count to avoid locking in surplus creeps as requirements
            if (intel.constructionSites.length > 0) {
                upCount = Math.ceil(desiredWork / (upStats.work || 1));
                if (desiredWork > 0 && upCount < 1) upCount = 1;
            }

            missions.push({
                name: upName,
                type: 'upgrade',
                archetype: upArch,
                targetId: intel.controller.id,
                pos: intel.controller.pos,
                requirements: {
                    archetype: upArch,
                    count: upCount
                },
                priority: upgradePriority
            });
        }

        // --- Priority 5: Construction ---
        if (intel.constructionSites.length > 0 && !isEmergency) {
            const buildName = 'build:sites';
            const buildCensus = getMissionCensus(buildName);
            const buildArch = 'worker';
            const buildStats = managerSpawner.checkBody('worker', budget);
            const buildTarget = 5;
            const buildDeficit = Math.max(0, buildTarget - buildCensus.work);
            const buildNeeded = Math.ceil(buildDeficit / (buildStats.work || 1));

            missions.push({
                name: buildName,
                type: 'build',
                archetype: buildArch,
                targetIds: intel.constructionSites.map(s => s.id),
                requirements: {
                    archetype: buildArch,
                    count: buildCensus.count + buildNeeded
                },
                priority: 60
            });
        }

        return missions;
    },

    visualize: function(room, missions, state) {
        room.visual.text(`State: ${state}`, 1, 1, {align: 'left', color: state === 'EMERGENCY' ? 'red' : 'green'});
        let y = 2;
        missions.forEach(m => {
            room.visual.text(`[${m.priority}] ${m.name}`, 1, y++, {align: 'left', font: 0.4});
        });
    },

    /**
     * Reassigns creeps between missions to optimize efficiency.
     * e.g. Moving upgraders to builders if construction sites appear.
     * @param {Room} room
     * @param {Object[]} missions
     * @param {Object} intel
     */
    reassignWorkers: function(room, missions, intel) {
        // Strategy: Construction Blitz
        // If we have construction sites, steal upgraders to build.
        if (intel.constructionSites.length > 0) {
            const buildMission = missions.find(m => m.name === 'build:sites');
            const upgradeMission = missions.find(m => m.name === 'upgrade:controller');

            if (buildMission && upgradeMission) {
                // Identify upgraders
                const upgraders = intel.myCreeps.filter(c => c.memory.missionName === 'upgrade:controller');
                
                // Keep a minimum number of upgraders (e.g. 1) to prevent downgrade or maintain minimal progress
                const minUpgraders = 1;
                
                if (upgraders.length > minUpgraders) {
                    // Take the excess
                    const availableToMove = upgraders.slice(minUpgraders);
                    
                    availableToMove.forEach(creep => {
                        // Switch mission
                        creep.memory.missionName = buildMission.name;
                        // Clear task state to force re-evaluation by Tasker
                        delete creep.memory.task;
                        creep.memory.taskState = 'init';
                        
                        // Update Census Data on the mission objects so Spawner sees the correct counts for this tick
                        if (upgradeMission.census) upgradeMission.census.count--;
                        if (buildMission.census) buildMission.census.count++;
                    });
                }
            }
        }
    },

    /**
     * Matches existing creeps to missions to determine current staffing levels.
     * @param {Object[]} missions 
     * @param {Creep[]} creeps 
     */
    analyzeCensus: function(missions, creeps) {
        const missionMap = {};
        missions.forEach(m => {
            m.census = { count: 0, workParts: 0, carryParts: 0 };
            missionMap[m.name] = m;
        });

        creeps.forEach(c => {
            if (c.memory.missionName && missionMap[c.memory.missionName]) {
                const m = missionMap[c.memory.missionName];
                m.census.count++;
                m.census.workParts += c.getActiveBodyparts(WORK);
                m.census.carryParts += c.getActiveBodyparts(CARRY);
            }
        });
    }
};

module.exports = managerOverseer;