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
        if (!room.memory.overseer) room.memory.overseer = {};

        // 1. Gather Intel
        const intel = this.gatherIntel(room);

        // 2. Determine Room State
        const state = this.determineState(room, intel);
        const economyState = this.determineEconomyState(room, intel);

        // 3. Generate Missions
        const missions = this.generateMissions(room, intel, state, economyState);

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
        room._economyState = economyState;

        // Publish to Memory
        room.memory.overseer.missions = missions;
        room.memory.overseer.state = state;
        room.memory.overseer.economyState = economyState;

        if (Memory.debug) {
            this.visualize(room, missions, state, economyState);
        }
    },

    /**
     * Analyzes the room to gather necessary data.
     * @param {Room} room 
     */
    gatherIntel: function(room) {
        const cache = global.getRoomCache(room);
        const terrain = room.getTerrain();
        const myCreeps = cache.myCreeps || [];
        const structures = cache.structuresByType || {};
        const dropped = cache.dropped || [];
        const ruins = cache.ruins || [];
        const tombstones = (cache.tombstones || []).filter(t => t.store[RESOURCE_ENERGY] > 0);
        
        const containers = structures[STRUCTURE_CONTAINER] || [];
        const storage = room.storage;
        
        const containerEnergy = containers.reduce((sum, c) => sum + c.store[RESOURCE_ENERGY], 0);
        const containerCapacity = containers.reduce((sum, c) => sum + c.store.getCapacity(RESOURCE_ENERGY), 0);
        const storageEnergy = storage ? storage.store[RESOURCE_ENERGY] : 0;
        const storageCapacity = storage ? storage.store.getCapacity(RESOURCE_ENERGY) : 0;

        // Hauler Capacity
        const logisticsCreeps = myCreeps.filter(c => 
            c.memory.missionName && c.memory.missionName.includes('logistics')
        );
        const haulerCapacity = logisticsCreeps.reduce((sum, c) => sum + c.store.getCapacity(RESOURCE_ENERGY), 0);

        // Aggregate Energy Sources (Logistics)
        const allEnergySources = [];
        if (storageEnergy > 0 && storage) {
            allEnergySources.push({ id: storage.id, pos: storage.pos, amount: storageEnergy, type: 'storage' });
        }
        containers.forEach(c => {
            if (c.store[RESOURCE_ENERGY] > 0) {
                allEnergySources.push({ id: c.id, pos: c.pos, amount: c.store[RESOURCE_ENERGY], type: 'container' });
            }
        });
        dropped.forEach(r => {
            if (r.resourceType === RESOURCE_ENERGY && r.amount > 50) {
                allEnergySources.push({ id: r.id, pos: r.pos, amount: r.amount, type: 'dropped' });
            }
        });
        ruins.forEach(r => {
            if (r.store[RESOURCE_ENERGY] > 0) {
                allEnergySources.push({ id: r.id, pos: r.pos, amount: r.store[RESOURCE_ENERGY], type: 'ruin' });
            }
        });
        tombstones.forEach(t => {
            allEnergySources.push({ id: t.id, pos: t.pos, amount: t.store[RESOURCE_ENERGY], type: 'tombstone' });
        });
        
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
            myCreeps: myCreeps,
            hostiles: cache.hostiles || [],
            constructionSites: cache.constructionSites || [],
            structures: structures,
            dropped: dropped,
            ruins: ruins,
            tombstones: tombstones,
            controller: room.controller,
            availableControllerSpaces: controllerSpaces,
            energyAvailable: room.energyAvailable,
            energyCapacityAvailable: room.energyCapacityAvailable,
            containerEnergy,
            containerCapacity,
            storageEnergy,
            storageCapacity,
            haulerCapacity,
            allEnergySources
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
     * Determines the economy state (Stockpiling vs Upgrading).
     * @param {Room} room
     * @param {Object} intel
     */
    determineEconomyState: function(room, intel) {
        let current = room.memory.overseer.economyState || 'STOCKPILING';
        
        // Identify mining containers to exclude from economy calculations
        const miningContainerIds = new Set();
        intel.sources.forEach(s => {
            if (s.containerId) miningContainerIds.add(s.containerId);
        });

        // Calculate logistics energy (excluding mining containers)
        const allContainers = intel.structures[STRUCTURE_CONTAINER] || [];
        const logisticsContainers = allContainers.filter(c => !miningContainerIds.has(c.id));
        
        const logisticsEnergy = logisticsContainers.reduce((sum, c) => sum + c.store[RESOURCE_ENERGY], 0);
        const logisticsCapacity = logisticsContainers.reduce((sum, c) => sum + c.store.getCapacity(RESOURCE_ENERGY), 0);

        const totalStored = logisticsEnergy + intel.storageEnergy;
        const totalCapacity = logisticsCapacity + intel.storageCapacity;
        
        // If no infrastructure, default to UPGRADING
        if (totalCapacity < 500) return 'UPGRADING';

        if (room.storage) {
            const UPGRADE_START = 50000;
            const UPGRADE_STOP = 10000;
            if (current === 'STOCKPILING' && totalStored >= UPGRADE_START) current = 'UPGRADING';
            else if (current === 'UPGRADING' && totalStored <= UPGRADE_STOP) current = 'STOCKPILING';
        } else {
            const UPGRADE_START = totalCapacity * 0.8;
            const UPGRADE_STOP = totalCapacity * 0.2;
            if (current === 'STOCKPILING' && totalStored >= UPGRADE_START) current = 'UPGRADING';
            else if (current === 'UPGRADING' && totalStored <= UPGRADE_STOP) current = 'STOCKPILING';
        }
        
        return current;
    },

    /**
     * Generates a list of missions based on intel and state.
     * @param {Room} room 
     * @param {Object} intel 
     * @param {String} state 
     * @param {String} economyState
     */
    generateMissions: function(room, intel, state, economyState) {
        const missions = [];
        
        // Define budget for body part calculation
        let budget = intel.energyCapacityAvailable;
        if (state === 'EMERGENCY') {
            budget = Math.max(intel.energyAvailable, 300);
        }
        
        // Group creeps by mission for census feedback
        const creepsByMission = intel.myCreeps.reduce((acc, c) => {
            const key = c.memory.missionName;
            acc[key] = acc[key] || [];
            acc[key].push(c);
            return acc;
        }, {});
        
        const getMissionCensus = (name) => {
            const creeps = creepsByMission[name] || [];
            return {
                count: creeps.length,
                work: creeps.reduce((sum, c) => sum + c.getActiveBodyparts(WORK), 0),
                carry: creeps.reduce((sum, c) => sum + c.getActiveBodyparts(CARRY), 0)
            };
        };

        // --- Priority 0: Defense (Towers) ---
        if (intel.hostiles.length > 0) {
            missions.push({
                name: 'tower:defense',
                type: 'tower_attack',
                targetIds: intel.hostiles.map(c => c.id),
                priority: 1000
            });
        }

        // --- Priority 0.5: Heal (Towers) ---
        const damagedCreeps = intel.myCreeps.filter(c => c.hits < c.hitsMax);
        if (damagedCreeps.length > 0) {
            missions.push({
                name: 'tower:heal',
                type: 'tower_heal',
                targetIds: damagedCreeps.map(c => c.id),
                priority: 950
            });
        }

        // --- Priority 4.5: Repair (Towers) ---
        // Only if we have reasonable energy
        if (intel.energyAvailable > intel.energyCapacityAvailable * 0.5) {
            const allStructures = [].concat(...Object.values(intel.structures));
            const damagedStructures = allStructures.filter(s => 
                s.hits < s.hitsMax && 
                s.structureType !== STRUCTURE_WALL && 
                s.structureType !== STRUCTURE_RAMPART
            );
            const criticalForts = allStructures.filter(s => 
                (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) && 
                s.hits < 5000
            );
            const allRepair = [...criticalForts, ...damagedStructures];
            if (allRepair.length > 0) {
                missions.push({
                    name: 'tower:repair',
                    type: 'tower_repair',
                    targetIds: allRepair.map(s => s.id),
                    priority: 40
                });
            }
        }

        // --- Priority 1: Survival (Emergency) ---
        // If emergency, we might want to suppress other missions or boost priority of harvesting
        const isEmergency = state === 'EMERGENCY';

        // Check for sufficient haulers to enable drop mining
        // Track available capacity for enabling drop mining per source
        let availableHaulerCapacity = intel.haulerCapacity;

        log(`[Overseer Debug] Hauler check: capacity=${intel.haulerCapacity}`);

        // Check if we should enable haulers based on harvester efficiency
        // Haulers are needed only when harvesters are leveled up enough so that their count needs are less than available spaces.
        const potentialHarvester = managerSpawner.checkBody('miner', budget);
        const potentialWork = potentialHarvester.work || 1;
        log(`[Overseer Debug] Harvester efficiency check: potentialWork=${potentialWork} (budget: ${budget})`);
        
        const efficientSources = new Set();
        intel.sources.forEach(s => {
            const needed = Math.ceil(5 / potentialWork);
            // We enable haulers if we have the tech (budget > 300), or a container exists, 
            // or if we somehow already have a fleet (e.g. from previous state)
            const isEfficientCheck = needed <= s.availableSpaces && (budget > 300 || s.hasContainer || intel.haulerCapacity > 0);
            // Only enable haulers if we have a container or better than basic RCL1 tech (budget > 300)
            if (isEfficientCheck) {
                efficientSources.add(s.id);
            }
            log(`[Overseer Debug] Source ${s.id}: needed=${needed}, availableSpaces=${s.availableSpaces}, hasContainer=${s.hasContainer}, budget=${budget}`);
            log(`[Overseer Debug] Source ${s.id}: isEfficientCheck=${isEfficientCheck}`);
        });
        const enableHaulers = efficientSources.size > 0;
        log(`[Overseer Debug] enableHaulers=${enableHaulers} (efficientSources: ${efficientSources.size})`);
        
        const allSourceIds = intel.allEnergySources.map(s => s.id);

        // Helper to find best source for a specific target
        const findBestSource = (targetPos) => {
            // Filter sources that have enough energy (e.g. > 50)
            const valid = intel.allEnergySources.filter(s => s.amount >= 50);
            if (valid.length === 0) return null;
            return targetPos.findClosestByRange(valid);
        };

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

            log(`[Overseer Debug] Harvest mission for ${source.id}: isEfficient=${isEfficient}, canDropMine=${canDropMine} (hasContainer: ${source.hasContainer}, hasCap: ${hasCap})`);
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

        // --- Priority 3: Logistics ---
        if (enableHaulers) {
            this.generateLogisticsMissions(room, intel, missions, isEmergency);
        }

        // --- Priority 4: Upgrading ---
        if (intel.controller && intel.controller.my && !isEmergency) {
            // Decide upgrade throttle based on economy
            let upgradePriority = 50;
            let desiredWork = 5;

            if (economyState === 'STOCKPILING') {
                desiredWork = 1;
                upgradePriority = 10;
                if (intel.controller.ticksToDowngrade < 5000) {
                    upgradePriority = 100; // Critical
                }
            } else {
                if (intel.energyAvailable === intel.energyCapacityAvailable) {
                    upgradePriority = 80;
                    desiredWork = 15;
                }
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
                data: { sourceIds: allSourceIds  },
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
                data: { sourceIds: allSourceIds  },
                requirements: {
                    archetype: buildArch,
                    count: buildCensus.count + buildNeeded
                },
                priority: 60
            });
        }

        return missions;
    },

    visualize: function(room, missions, state, economyState) {
        room.visual.text(`State: ${state} | Eco: ${economyState}`, 1, 1, {align: 'left', color: state === 'EMERGENCY' ? 'red' : '#00ff00', font: 0.7});
        
        let y = 2.5;
        const sortedMissions = [...missions].sort((a, b) => b.priority - a.priority);

        sortedMissions.forEach(m => {
            const assigned = m.census ? m.census.count : 0;
            const required = m.requirements ? m.requirements.count : 0;
            const filled = assigned >= required;
            const color = filled ? '#aaffaa' : '#ffaaaa';

            room.visual.text(`[${m.priority}] ${m.name} (${assigned}/${required})`, 1, y, {align: 'left', font: 0.4, color: color});
            y += 0.6;

            if (m.pos) {
                let label = `${m.type}`;
                if (m.type === 'harvest' && m.data && m.data.mode) {
                    label += ` (${m.data.mode})`;
                }
                label += `\n${assigned}/${required}`;

                room.visual.text(
                    label,
                    m.pos.x,
                    m.pos.y - 0.5,
                    { font: 0.3, color: color, stroke: '#000000', strokeWidth: 0.15, align: 'center' }
                );
                if (m.type === 'harvest') {
                    room.visual.circle(m.pos, {fill: 'transparent', radius: 0.7, stroke: color, strokeWidth: 0.1, lineStyle: 'dashed'});
                }
            } else if (m.type === 'build' && m.targetIds && m.targetIds.length > 0) {
                m.targetIds.forEach(id => {
                    const target = Game.getObjectById(id);
                    if (target) {
                        room.visual.text(`🔨 ${assigned}/${required}`, target.pos.x, target.pos.y, { font: 0.3, color: color, stroke: '#000000', strokeWidth: 0.15 });
                    }
                });
            }
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
        // Helper to move creeps between missions
        const moveCreeps = (fromMissionName, toMission, count) => {
            if (!toMission || count <= 0) return;
            const fromCreeps = intel.myCreeps.filter(c => c.memory.missionName === fromMissionName);
            
            let moved = 0;
            for (let creep of fromCreeps) {
                if (moved >= count) break;
                
                creep.memory.missionName = toMission.name;
                delete creep.memory.task;
                creep.memory.taskState = 'init';
                
                // Update Census
                const fromMission = missions.find(m => m.name === fromMissionName);
                if (fromMission && fromMission.census) fromMission.census.count--;
                if (toMission.census) toMission.census.count++;
                
                moved++;
            }
        };

        // Strategy: Construction Blitz
        // If we have construction sites, steal upgraders to build.
        if (intel.constructionSites.length > 0) {
            const buildMission = missions.find(m => m.name === 'build:sites');
            const upgradeMission = missions.find(m => m.name === 'upgrade:controller');

            if (buildMission && upgradeMission) {
                const upgraders = intel.myCreeps.filter(c => c.memory.missionName === 'upgrade:controller');
                const minUpgraders = 1;
                const available = upgraders.length - minUpgraders;
                
                if (available > 0) {
                    moveCreeps('upgrade:controller', buildMission, available);
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
    },

    generateLogisticsMissions: function(room, intel, missions, isEmergency) {
        const activeMissions = new Map();
        
        // 1. Identify active hauling missions to prevent thrashing
        intel.myCreeps.forEach(c => {
            if (c.memory.missionName && c.memory.missionName.startsWith('haul:')) {
                const parts = c.memory.missionName.split(':');
                // Format: haul:sourceId:targetId
                if (parts.length === 3) {
                    const sourceId = parts[1];
                    const targetId = parts[2];
                    const source = Game.getObjectById(sourceId);
                    const target = Game.getObjectById(targetId);
                    
                    // Check validity
                    const creepHasEnergy = c.store[RESOURCE_ENERGY] > 0;
                    const sourceHasEnergy = source && (
                        (source.store && source.store[RESOURCE_ENERGY] > 0) || 
                        (source.amount && source.amount > 0)
                    );
                    
                    const isSourceValid = source && (creepHasEnergy || sourceHasEnergy);
                    const isTargetValid = target && target.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
                    
                    if (isSourceValid && isTargetValid) {
                        const mission = {
                            name: c.memory.missionName,
                            type: 'transfer',
                            archetype: 'hauler',
                            targetId: targetId,
                            data: { sourceId: sourceId },
                            requirements: { archetype: 'hauler', count: 1 },
                            priority: this.getLogisticsPriority(target, isEmergency)
                        };
                        activeMissions.set(c.memory.missionName, mission);
                    }
                }
            }
        });

        // 2. Identify Needs (Requestors)
        const requestors = [];
        
        // Towers
        (intel.structures[STRUCTURE_TOWER] || []).forEach(t => {
            if (t.store.getFreeCapacity(RESOURCE_ENERGY) > 0) requestors.push(t);
        });
        
        // Spawns & Extensions
        (intel.structures[STRUCTURE_SPAWN] || []).forEach(s => {
            if (s.store.getFreeCapacity(RESOURCE_ENERGY) > 0) requestors.push(s);
        });
        (intel.structures[STRUCTURE_EXTENSION] || []).forEach(e => {
            if (e.store.getFreeCapacity(RESOURCE_ENERGY) > 0) requestors.push(e);
        });
        
        // Containers (Controller & others, excluding mining)
        const miningContainerIds = new Set(intel.sources.map(s => s.containerId).filter(id => id));
        (intel.structures[STRUCTURE_CONTAINER] || []).forEach(c => {
            if (!miningContainerIds.has(c.id) && c.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                requestors.push(c);
            }
        });

        // 3. Generate Missions for Needs
        requestors.forEach(target => {
            // Check if already covered by an active mission
            let covered = false;
            for (const [name, m] of activeMissions) {
                if (m.targetId === target.id) {
                    covered = true;
                    break;
                }
            }
            
            if (!covered) {
                const bestSource = this.findBestSource(target.pos, intel.allEnergySources);
                if (bestSource) {
                    const missionName = `haul:${bestSource.id}:${target.id}`;
                    const priority = this.getLogisticsPriority(target, isEmergency);
                    
                    const mission = {
                        name: missionName,
                        type: 'transfer',
                        archetype: 'hauler',
                        targetId: target.id,
                        data: { sourceId: bestSource.id },
                        requirements: { archetype: 'hauler', count: 1 },
                        priority: priority
                    };
                    activeMissions.set(missionName, mission);
                }
            }
        });

        // 4. Push to main list
        for (const m of activeMissions.values()) {
            missions.push(m);
        }
    },

    findBestSource: function(targetPos, sources) {
        const valid = sources.filter(s => s.amount >= 50);
        if (valid.length === 0) return null;
        return targetPos.findClosestByRange(valid);
    },

    getLogisticsPriority: function(target, isEmergency) {
        switch(target.structureType) {
            case STRUCTURE_TOWER: return isEmergency ? 950 : 95;
            case STRUCTURE_SPAWN: return isEmergency ? 900 : 90;
            case STRUCTURE_EXTENSION: return isEmergency ? 900 : 90;
            case STRUCTURE_CONTAINER: return 50;
            case STRUCTURE_STORAGE: return 10;
            default: return 10;
        }
    }
};

module.exports = managerOverseer;