var managerRoomEconomy = require('managers_manager.room.economy');

module.exports = {
    /**
     * Runs all logic for a specific owned room (Colony)
     * @param {Room} room 
     * @param {StructureSpawn} spawn 
     * @param {Creep[]} allCreeps 
     */
    run: function(room, spawn, allCreeps) {
        // Energy in Spawns and Extensions (for spawning)
        const energyForSpawning = room.energyAvailable;

        // Find all containers and sum the energy they hold
        const containers = room.find(FIND_STRUCTURES, {
            filter: { structureType: STRUCTURE_CONTAINER }
        });
        const containerEnergy = containers.reduce((sum, c) => sum + c.store.getUsedCapacity(RESOURCE_ENERGY), 0);

        // Get energy from the room's storage, if it exists
        const storageEnergy = room.storage ? room.storage.store.getUsedCapacity(RESOURCE_ENERGY) : 0;

        // This is the total energy stored in containers and storage
        const totalStoredEnergy = containerEnergy + storageEnergy;

        // This is all the energy in the room
        const totalRoomEnergy = energyForSpawning + totalStoredEnergy;

        // You can log these values to your console to monitor them
        log(`[Economy] Room Name:  ${room.name}, Energy Capacity: ${room.energyCapacityAvailable}, Energy for Spawning: ${energyForSpawning}, Stored Energy: ${totalStoredEnergy}, Total Room Energy: ${totalRoomEnergy}`);

        // --- CREEP CENSUS ---
        // Filter by homeRoom to ensure we count creeps belonging to this colony, even if they are currently stepping out.
        // Fallback to creep.room.name for legacy creeps that might not have homeRoom set yet.
        const belongsToColony = (c) => c.memory.homeRoom === room.name || (!c.memory.homeRoom && c.room.name === room.name);

        var harvesters = allCreeps.filter((creep) => creep.memory.role == 'harvester' && belongsToColony(creep));
        var haulers = allCreeps.filter((creep) => creep.memory.role == 'hauler' && belongsToColony(creep));
        var hauler_controller_specials = allCreeps.filter((creep) => creep.memory.role == 'hauler_controller_special' && belongsToColony(creep));
        var harvesters_big = allCreeps.filter((creep) => creep.memory.role == 'harvester_big' && belongsToColony(creep));
        var upgraders = allCreeps.filter((creep) => creep.memory.role == 'upgrader' && belongsToColony(creep));
        var builders = allCreeps.filter((creep) => creep.memory.role == 'builder' && belongsToColony(creep));
        var mission_defenders_range = allCreeps.filter((creep) => creep.memory.role == 'mission_defender_range' && belongsToColony(creep));
        var mission_range_healers = allCreeps.filter((creep) => creep.memory.role == 'mission_range_healer' && belongsToColony(creep));
        var mission_defenders_tank = allCreeps.filter((creep) => creep.memory.role == 'mission_defender_tank' && belongsToColony(creep));
        var scouts = allCreeps.filter((creep) => creep.memory.role == 'scout' && belongsToColony(creep));
        var mission_reservers = allCreeps.filter((creep) => creep.memory.role == 'mission_reserver' && belongsToColony(creep));
        var mission_claimers = allCreeps.filter((creep) => creep.memory.role == 'mission_claimer' && belongsToColony(creep));
        var drainers = allCreeps.filter((creep) => creep.memory.role == 'drainer' && belongsToColony(creep));
        var mission_bootstraps = allCreeps.filter((creep) => creep.memory.role == 'mission_bootstrap' && belongsToColony(creep));
        var mission_haulers_interroom = allCreeps.filter((creep) => creep.memory.role == 'mission_hauler_interroom' && belongsToColony(creep));
        var mission_dismantlers = allCreeps.filter((creep) => creep.memory.role == 'mission_dismantler' && belongsToColony(creep));

        const totalHarvesterCount = harvesters.length + harvesters_big.length;

        // --- ECONOMY PLANNING ---
        const census = {
            harvester: harvesters.length,
            harvester_big: harvesters_big.length,
            hauler: haulers.length,
            upgrader: upgraders.length,
            builder: builders.length,
            hauler_controller_special: hauler_controller_specials.length
        };

        // Get the plan from the manager
        const plan = managerRoomEconomy.plan(room, census);
        const desiredUpgraders = plan.targets.upgrader;
        const desiredBuilders = plan.targets.builder;
        const desiredHaulers = plan.targets.hauler;
        const desiredHaulerControllerSpecials = plan.targets.hauler_controller_special;
        const desiredHarvestersBig = plan.targets.harvester_big;

        let desiredMissionRangeDefenders = 0;
        let desiredMissionTankDefenders = 0;
        let desiredMissionRangeHealers = 0;
        let desiredMovingHouseHaulers = 0;
        let desiredMissionReservers = 0;
        let desiredMissionDismantlers = 0;
        let desiredMissionBootstrap = 0;
        let activeRemoteMiningMissions = [];
        let activeReserverMissions = [];

        // Switch to turn on off needed combatants or intensive stuff like remote miners or mission manager controlled
        let scoutOn = 0;
        let reserverMissionOn = 0;
        let claimerMissionOn = 0;
        let haulerControllerSpecialOn = desiredHaulerControllerSpecials > 0 ? 1 : 0;
        let bootstrapMissionOn = 0;
        let dismantleMissionOn = 0;
        let movingHouseMissionOn = 0;
        let missionBodies = {
            defender: [RANGED_ATTACK, MOVE],
            healer: [HEAL, MOVE],
            tank: [TOUGH, MOVE, ATTACK]
        };

        const roomEnergyAvailable = room.energyAvailable;

        // Helper to calculate body cost
        const getBodyCost = (body) => body.reduce((cost, part) => cost + BODYPART_COST[part], 0);

        // --- Start of Harvester Spawn Logic ---
        // Small vs Big Harvester logic, based on the room's energy capacity, energy availability and also number of sources
        
        // Count sources to dynamically scale creep targets
        const numSources = room.find(FIND_SOURCES).length;

        const bigHarvesterBody = plan.bodies.harvester_big;
        const bigHarvesterCost = getBodyCost(bigHarvesterBody);

        // --- MISSION CONTROL INTEGRATION ---
        if (Memory.missionControl && Memory.missionControl.squads) {
            // 1. Alpha Squad (Combat)
            if (Memory.missionControl.squads.alpha) {
                let squad = Memory.missionControl.squads.alpha;
                
                let isSpawnRoom = true;
                if (squad.spawnRoom && squad.spawnRoom !== room.name) {
                    isSpawnRoom = false;
                }

                if (isSpawnRoom && squad.state === 'assembling') {
                    desiredMissionRangeDefenders = squad.targetSize.defender;
                    desiredMissionRangeHealers = squad.targetSize.healer;
                    desiredMissionTankDefenders = squad.targetSize.tank;

                    if (squad.bodies) {
                        missionBodies = squad.bodies;
                    }
                } else {
                    desiredMissionRangeDefenders = 0;
                    desiredMissionRangeHealers = 0;
                    desiredMissionTankDefenders = 0;
                }
            }

            // 2. Reserver Mission
            if (Memory.missionControl.squads.reserver) {
                // Support multiple missions
                if (Memory.missionControl.squads.reserver.active === undefined) {
                    for (let flagName in Memory.missionControl.squads.reserver) {
                        let mission = Memory.missionControl.squads.reserver[flagName];
                        if (mission.active && mission.spawnRoom === room.name) {
                            activeReserverMissions.push({
                                flagName: flagName,
                                mission: mission
                            });
                        }
                    }
                } else {
                    // Legacy support
                    let mission = Memory.missionControl.squads.reserver;
                    if (mission.active && mission.spawnRoom === room.name) {
                        reserverMissionOn = 1;
                        desiredMissionReservers = 1;
                    } else {
                        reserverMissionOn = 0;
                    }
                }
            }

            // 3. Claimer Mission
            if (Memory.missionControl.squads.claimer) {
                let mission = Memory.missionControl.squads.claimer;
                if (mission.active && mission.spawnRoom === room.name && mission.wantSpawn) {
                    claimerMissionOn = 1;
                    desiredMissionClaimers = 100; // Force spawn regardless of current count
                } else {
                    claimerMissionOn = 0;
                }
            }

            // 4. Bootstrap Mission
            if (Memory.missionControl.squads.bootstrap) {
                let mission = Memory.missionControl.squads.bootstrap;
                if (mission.active && mission.spawnRoom === room.name) {
                    bootstrapMissionOn = 1;
                    desiredMissionBootstrap = 2;
                } else {
                    bootstrapMissionOn = 0;
                }
            }

            // 5. Dismantle Mission
            if (Memory.missionControl.squads.dismantle) {
                let mission = Memory.missionControl.squads.dismantle;
                if (mission.active && mission.spawnRoom === room.name) {
                    dismantleMissionOn = 1;
                    desiredMissionDismantlers = 1;
                } else {
                    dismantleMissionOn = 0;
                }
            }

            // 6. Moving House Mission
            if (Memory.missionControl.squads.movinghouse) {
                let mission = Memory.missionControl.squads.movinghouse;
                if (mission.active && mission.spawnRoom === room.name) {
                    movingHouseMissionOn = 1;
                    desiredMovingHouseHaulers = mission.desiredAmount;
                } else {
                    movingHouseMissionOn = 0;
                }
            }

            // 7. Remote Mining Mission
            if (Memory.missionControl.squads.remoteMining) {
                for (let flagName in Memory.missionControl.squads.remoteMining) {
                    let mission = Memory.missionControl.squads.remoteMining[flagName];
                    if (mission.active && mission.spawnRoom === room.name) {
                        activeRemoteMiningMissions.push({
                            flagName: flagName,
                            mission: mission
                        });
                    }
                }
            }
        }

        // --- SPAWN QUEUE GENERATION ---
        // Priority based spawning system to resolve bottlenecks
        let spawnQueue = [];

        // 1. CRITICAL SURVIVAL (Emergency)
        // If we have absolutely no harvesters, we need one immediately.
        if (harvesters.length + harvesters_big.length === 0) {
            spawnQueue.push({
                role: 'harvester',
                body: [WORK, CARRY, MOVE],
                priority: 100,
                name: 'HarvesterBootstrap'
            });
        }
        // If we have big harvesters (which are static) but no haulers, we are stuck.
        if (harvesters_big.length > 0 && haulers.length === 0) {
            spawnQueue.push({
                role: 'hauler',
                body: [CARRY, MOVE],
                priority: 95,
                name: 'HaulerBootstrap'
            });
        }

        // 2. CRITICAL INFRASTRUCTURE (Recovery)
        // If we have no builders but need them (sites exist)
        if (builders.length === 0 && desiredBuilders > 0) {
            spawnQueue.push({
                role: 'builder',
                body: plan.bodies.builder,
                priority: 90,
                name: 'BuilderRecovery'
            });
        }
        // If we have no upgraders but need them (prevent downgrade)
        if (upgraders.length === 0 && desiredUpgraders > 0) {
            spawnQueue.push({
                role: 'upgrader',
                body: plan.bodies.upgrader,
                priority: 85,
                name: 'UpgraderRecovery'
            });
        }

        // 3. CORE ECONOMY (Fill to Target)
        // Harvesters (Big) - Pre-spawn logic
        const dyingHarvestersBig = harvesters_big.filter(c => c.ticksToLive < 100).length;
        if (harvesters_big.length < desiredHarvestersBig + dyingHarvestersBig) {
            spawnQueue.push({
                role: 'harvester_big',
                body: plan.bodies.harvester_big,
                priority: 80,
                name: 'BigHarvester'
            });
        }

        // Haulers - Pre-spawn logic
        const dyingHaulers = haulers.filter(c => c.ticksToLive < 50).length;
        if (haulers.length < desiredHaulers + dyingHaulers) {
            spawnQueue.push({
                role: 'hauler',
                body: plan.bodies.hauler,
                priority: 70,
                name: 'Hauler'
            });
        }

        // Builders
        if (builders.length < desiredBuilders) {
            spawnQueue.push({
                role: 'builder',
                body: plan.bodies.builder,
                priority: 50,
                name: 'Builder'
            });
        }

        // Upgraders
        if (upgraders.length < desiredUpgraders) {
            spawnQueue.push({
                role: 'upgrader',
                body: plan.bodies.upgrader,
                priority: 40,
                name: 'Upgrader'
            });
        }

        // Special Haulers
        if (hauler_controller_specials.length < desiredHaulerControllerSpecials) {
            spawnQueue.push({
                role: 'hauler_controller_special',
                body: plan.bodies.hauler_controller_special,
                priority: 35,
                name: 'HaulerCustomController'
            });
        }

        // 4. MISSION & REMOTE (Lower Priority)
        if (desiredMissionRangeHealers > 0 && mission_range_healers.length < desiredMissionRangeHealers) {
            spawnQueue.push({ role: 'mission_range_healer', body: missionBodies.healer, priority: 40, name: 'MissionRangeHealer' });
        }
        // Legacy Reserver Spawn
        if (reserverMissionOn == 1 && mission_reservers.length < desiredMissionReservers && activeReserverMissions.length === 0) {
             let targetRoom = Memory.missionControl.squads.reserver ? Memory.missionControl.squads.reserver.targetRoom : 'NA';
             spawnQueue.push({ role: 'mission_reserver', body: [CLAIM,MOVE], priority: 30, name: 'MissionReserver', memory: {targetRoom: targetRoom} });
        }
        // Multi-Reserver Spawn
        for (let item of activeReserverMissions) {
            let mission = item.mission;
            let existing = mission_reservers.find(c => c.memory.targetRoom === mission.targetRoom);
            if (!existing) {
                let inQueue = spawnQueue.find(q => q.memory && q.memory.role === 'mission_reserver' && q.memory.targetRoom === mission.targetRoom);
                if (!inQueue) {
                    spawnQueue.push({ role: 'mission_reserver', body: [CLAIM,MOVE], priority: 30, name: 'MissionReserver_' + mission.targetRoom, memory: {targetRoom: mission.targetRoom} });
                }
            }
        }
        if (claimerMissionOn == 1 && mission_claimers.length < desiredMissionClaimers) {
            let targetRoom = Memory.missionControl.squads.claimer ? Memory.missionControl.squads.claimer.targetRoom : 'NA';
            spawnQueue.push({ role: 'mission_claimer', body: [CLAIM,MOVE], priority: 30, name: 'MissionClaimer', memory: {targetRoom: targetRoom}, onSpawn: () => {
                if (Memory.missionControl.squads.claimer) {
                    Memory.missionControl.squads.claimer.wantSpawn = false;
                    Memory.missionControl.squads.claimer.lastLaunch = Game.time;
                }
            }});
        }
        if (bootstrapMissionOn == 1 && mission_bootstraps.length < desiredMissionBootstrap) {
            let targetRoom = Memory.missionControl.squads.bootstrap ? Memory.missionControl.squads.bootstrap.targetRoom : 'NA';
            let body = [WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE];
            if (roomEnergyAvailable >= 600) body = [WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE];
            spawnQueue.push({ role: 'mission_bootstrap', body: body, priority: 30, name: 'MissionBootstrap', memory: {targetRoom: targetRoom} });
        }
        if (dismantleMissionOn == 1 && mission_dismantlers.length < desiredMissionDismantlers) {
            let targetRoom = Memory.missionControl.squads.dismantle ? Memory.missionControl.squads.dismantle.targetRoom : 'NA';
            let body = [];
            let pairs = Math.min(25, Math.floor(roomEnergyAvailable / 150));
            for(let i=0; i<pairs; i++) { body.push(WORK); body.push(MOVE); }
            spawnQueue.push({ role: 'mission_dismantler', body: body, priority: 30, name: 'MissionDismantler', memory: {targetRoom: targetRoom} });
        }
        if (movingHouseMissionOn == 1 && mission_haulers_interroom.length < desiredMovingHouseHaulers) {
            let body = [];
            let parts = Math.min(25, Math.floor(roomEnergyAvailable / 100));
            for(let i=0; i<parts; i++) { body.push(CARRY); body.push(MOVE); }
            spawnQueue.push({ role: 'mission_hauler_interroom', body: body, priority: 30, name: 'MovingHouseHauler' });
        }
        if (desiredMissionRangeDefenders > 0 && mission_defenders_range.length < desiredMissionRangeDefenders) {
            spawnQueue.push({ role: 'mission_defender_range', body: missionBodies.defender, priority: 45, name: 'MissionDefenderRange' });
        }
        if (desiredMissionTankDefenders > 0 && mission_defenders_tank.length < desiredMissionTankDefenders) {
            spawnQueue.push({ role: 'mission_defender_tank', body: missionBodies.tank, priority: 30, name: 'MissionDefenderTank' });
        }
        if (Game.flags['FlagDrainer'] && drainers.length < 1) {
            spawnQueue.push({ role: 'drainer', body: [TOUGH,TOUGH,MOVE,MOVE,MOVE,MOVE,HEAL,HEAL], priority: 45, name: 'Drainer' });
        }
        if (scoutOn == 1 && scouts.length < 1) {
            spawnQueue.push({ role: 'scout', body: [MOVE], priority: 10, name: 'Scout' });
        }

        // Remote mining, slightly more complex
        for (let item of activeRemoteMiningMissions) {
            let flagName = item.flagName;
            let mission = item.mission;

            for (let sourceId in mission.sources) {
                // --- HARVESTER LOGIC ---
                // Check if we have a live creep for this source
                let existingCreep = allCreeps.find(c => c.memory.role === 'mission_remote_harvester' && c.memory.missionFlag === flagName && c.memory.targetSourceId === sourceId);
                
                // Update mission memory if needed (self-healing)
                if (existingCreep && mission.sources[sourceId] !== existingCreep.name) {
                    mission.sources[sourceId] = existingCreep.name;
                }
                
                if (!existingCreep && (!mission.sources[sourceId] || !Game.creeps[mission.sources[sourceId]])) {
                        // Check if already in spawn queue to prevent duplicates
                        let inQueue = spawnQueue.find(q => q.memory && q.memory.role === 'mission_remote_harvester' && q.memory.missionFlag === flagName && q.memory.targetSourceId === sourceId);
                        if (!inQueue) {
                            // Spawn logic
                            let body = [WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE]; // 550
                            if (roomEnergyAvailable >= 1000) {
                                body = [WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE]; // 5W (500) + 3C (150) + 5M (250) = 900
                            }
                            
                            spawnQueue.push({
                            role: 'mission_remote_harvester',
                            body: body,
                            priority: 25, // Lower priority
                            name: 'RMiner_' + flagName + '_' + sourceId.slice(-4),
                            memory: {
                                missionFlag: flagName,
                                targetRoom: mission.targetRoom,
                                targetSourceId: sourceId
                            }
                            });
                        }
                }

                // --- HAULER LOGIC ---
                let DESIRED_REMOTE_HAULERS = 1;
                if (mission.sourceDetails && mission.sourceDetails[sourceId] && mission.sourceDetails[sourceId].desiredHaulers) {
                    DESIRED_REMOTE_HAULERS = mission.sourceDetails[sourceId].desiredHaulers;
                }

                let existingHaulers = allCreeps.filter(c => c.memory.role === 'mission_remote_hauler' && c.memory.missionFlag === flagName && c.memory.targetSourceId === sourceId);
                let haulersInQueue = spawnQueue.filter(q => q.memory && q.memory.role === 'mission_remote_hauler' && q.memory.missionFlag === flagName && q.memory.targetSourceId === sourceId).length;

                if (existingHaulers.length + haulersInQueue < DESIRED_REMOTE_HAULERS) {
                    // Calculate Body: 1:1 CARRY:MOVE ratio for speed/roads
                    let body = [];
                    let availableEnergy = roomEnergyAvailable;
                    // Cap at 1500 energy (30 parts) to avoid overly large creeps on remote paths
                    let maxEnergy = Math.min(availableEnergy, 1500); 
                    let parts = Math.floor(maxEnergy / 100); // 50 for CARRY + 50 for MOVE
                    if (parts > 25) parts = 25; // Max 50 body parts
                    if (parts < 1) parts = 1;

                    for (let i = 0; i < parts; i++) {
                        body.push(CARRY);
                        body.push(MOVE);
                    }

                    spawnQueue.push({
                        role: 'mission_remote_hauler',
                        body: body,
                        priority: 24, // Slightly lower than miner
                        name: 'RHauler_' + flagName + '_' + sourceId.slice(-4),
                        memory: {
                            missionFlag: flagName,
                            targetRoom: mission.targetRoom,
                            targetSourceId: sourceId,
                            homeRoom: room.name
                        }
                    });
                }
            }
        }


        // --- EXECUTE SPAWN ---
        if (!spawn.spawning) {
            if (spawnQueue.length > 0) {
                spawnQueue.sort((a, b) => b.priority - a.priority);
                const nextSpawn = spawnQueue[0];
                
                // Construct memory
                let memory = nextSpawn.memory || {};
                memory.role = nextSpawn.role;
                memory.homeRoom = room.name;
                
                if (nextSpawn.role.includes('harvester') || nextSpawn.role.includes('hauler')) {
                    if (!memory.random_source_target_id) memory.random_source_target_id = 'NA';
                }

                log(`Spawning ${nextSpawn.name} (Priority ${nextSpawn.priority})`);
                
                let result = spawn.spawnCreep(nextSpawn.body, nextSpawn.name + Game.time, { memory: memory });
                if (result === OK && nextSpawn.onSpawn) {
                    nextSpawn.onSpawn();
                }
            }
        } // End if(!spawn.spawning)
    }
}
