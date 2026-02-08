// Helper to calculate body cost
const getBodyCost = (body) => body.reduce((cost, part) => cost + BODYPART_COST[part], 0);

// Helper to select the best body tier based on a budget
const getTieredBody = function(budget, tiers) {
    let bestBody = tiers[0];
    for (let i = 0; i < tiers.length; i++) {
        let body = tiers[i];
        let cost = getBodyCost(body);
        if (isNaN(cost)) {
            log(`[Economy] Error: Cost is NaN for body ${JSON.stringify(body)}. Check BODYPART_COST.`);
            break;
        }
        if (cost <= budget) {
            bestBody = body;
        } else {
            break;
        }
    }
    return bestBody;
};

module.exports = {
    /**
     * Decides the desired creep counts and body compositions for the room.
     * @param {Room} room 
     * @param {Object} census - Object containing counts of current creeps (e.g. { harvester: 1, upgrader: 2 })
     */
    plan: function(room, census) {

        // Initialize memory
        if (!room.memory.economy) {
            room.memory.economy = {
                plan: null,
                lastTick: 0,
                lastRCL: 0,
                lastCapacity: 0,
                wasEmergency: false
            };
        }
        const mem = room.memory.economy;

        // --- DEFENSE LOGIC (Always run) ---
        const dangerousHostiles = room.find(FIND_HOSTILE_CREEPS, {
            filter: (c) => (c.getActiveBodyparts(ATTACK) > 0 || c.getActiveBodyparts(RANGED_ATTACK) > 0) &&
                            c.owner.username !== 'QuanLe' 
        });
        
        if (dangerousHostiles.length > 0) {
            // AUTOMATIC DEFENSE TRIGGER
            const spawn = room.find(FIND_MY_SPAWNS)[0];
            const defenseTarget = spawn || room.controller;
            const closestHostile = defenseTarget.pos.findClosestByRange(dangerousHostiles);

            if (closestHostile) {
                // Move/Create Rally Flag on the enemy
                if (Game.flags['FlagRallyDefender']) {
                    Game.flags['FlagRallyDefender'].setPosition(closestHostile.pos);
                } else {
                    room.createFlag(closestHostile.pos, 'FlagRallyDefender');
                }

                // Move/Create Assembly Flag near spawn (safe spot)
                if (spawn) {
                    // Pick a spot slightly away from spawn to avoid blocking
                    let ay = Math.max(1, spawn.pos.y - 4);
                    const assemblyPos = new RoomPosition(spawn.pos.x, ay, room.name);
                    
                    if (Game.flags['FlagAssembly']) {
                        Game.flags['FlagAssembly'].setPosition(assemblyPos);
                    } else {
                        room.createFlag(assemblyPos, 'FlagAssembly');
                    }
                }
            }
        } else {
            // No hostiles. If we have defense flags in this room, remove them to stand down.
            if (Game.flags['FlagRallyDefender'] && Game.flags['FlagRallyDefender'].pos.roomName === room.name) {
                Game.flags['FlagRallyDefender'].remove();
            }
            if (Game.flags['FlagAssembly'] && Game.flags['FlagAssembly'].pos.roomName === room.name) {
                Game.flags['FlagAssembly'].remove();
            }
        }

        // --- ECONOMY LOGIC ---

        // 1. Check Emergency (Always check this to react immediately)
        const isEmergency = (census.harvester_big || 0) === 0 && (census.harvester || 0) === 0;

        // 2. Check Construction Sites (Light detection for builders)
        const numSites = room.find(FIND_CONSTRUCTION_SITES).length;
        const needsBuilders = numSites > 0 && mem.plan && mem.plan.targets.builder === 0;

        // 3. Determine if recalculation is needed
        let needRecalc = false;
        if (!mem.plan) needRecalc = true;
        else if (Game.time - mem.lastTick >= 20) needRecalc = true; // Run every 20 ticks
        else if (mem.wasEmergency !== isEmergency) needRecalc = true; // Emergency state changed
        else if (mem.lastRCL !== room.controller.level) needRecalc = true; // RCL changed
        else if (mem.lastCapacity !== room.energyCapacityAvailable) needRecalc = true; // Extensions built
        else if (needsBuilders) needRecalc = true; // New construction sites appeared

        if (!needRecalc) {
            return mem.plan;
        }

        // 1. Check if room properties actually exist
        log(`[Economy] Debug ${room.name}: Avail: ${room.energyAvailable}, Cap: ${room.energyCapacityAvailable}`);
    
        // 2. Check if census is what you expect
        log(`[Economy] Census Check: ${JSON.stringify(census)}`);
        const numSources = room.find(FIND_SOURCES).length;
        
        // --- 1. Determine Economic State ---
        // Emergency: No big harvesters and no small harvesters. We are wiped out.
        // const isEmergency = (census.harvester_big || 0) === 0 && (census.harvester || 0) === 0; // Calculated above
        
        // Budget: In emergency, use whatever we have. In normal times, aim for max capacity.
        const energyBudget = isEmergency ? Math.max(room.energyAvailable, 300) : room.energyCapacityAvailable;

        // --- 2. Define Body Tiers ---
        const bigHarvesterTiers = [
            [WORK, WORK, CARRY, MOVE], // 300
            [WORK, WORK, WORK, CARRY, CARRY, MOVE], // 450
            [WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE], // 550
            [WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE], // 650
            [WORK, WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE], // 750
        ];

        const upgraderTiers = [
            [WORK, CARRY, MOVE], // 300 
            [WORK, WORK, CARRY, CARRY, MOVE, MOVE], // 400
            [WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE], // 650
            [WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE],
            [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE],
        ];

        const builderTiers = [
            [WORK, CARRY, MOVE],
            [WORK, CARRY, CARRY, MOVE],
            [WORK, CARRY, MOVE, WORK, CARRY, MOVE],
            [WORK, CARRY, MOVE, WORK, CARRY, MOVE, WORK, CARRY, MOVE],
            [WORK, CARRY, MOVE, WORK, CARRY, MOVE, WORK, CARRY, MOVE, WORK, CARRY, MOVE],
        ];

        const haulerTiers = [
            [CARRY, MOVE],
            [CARRY, CARRY, MOVE, MOVE],
            [CARRY, CARRY, CARRY, MOVE, MOVE, MOVE],
            [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
            [CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE],
            [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
            [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
        ];

        // --- 3. Select Bodies ---
        const bodies = {
            harvester_big: getTieredBody(energyBudget, bigHarvesterTiers),
            upgrader: getTieredBody(energyBudget, upgraderTiers),
            builder: getTieredBody(energyBudget, builderTiers),
            hauler: getTieredBody(energyBudget, haulerTiers),
            // Default bodies for roles that don't scale as much
            defender: [TOUGH, ATTACK, MOVE],
            hauler_controller_special: getTieredBody(energyBudget, haulerTiers)
        };

        // --- 4. Calculate Target Counts ---
        const targets = {
            harvester_big: numSources,
            upgrader: 0,
            builder: 0,
            hauler: 0,
            defender: 0,
            hauler_controller_special: 0
        };

        if (isEmergency) {
            // Bootstrap Mode
            targets.harvester_big = 0; // Don't try to spawn big ones yet if we can't afford
            targets.builder = 1;       // Minimal builder
            targets.hauler = 1;        // Minimal hauler
            // Note: runColony handles the fallback to small 'harvester' role if harvester_big is 0
        } 
        else if ((census.harvester_big || 0) >= numSources) {
            // Stable Economy Mode
            
            const haulerCost = getBodyCost(bodies.hauler);

            // Harvesters: Scale based on WORK parts
            const harvesterWorkParts = bodies.harvester_big.filter(p => p === WORK).length;
            // 5 WORK parts saturate a source (10 energy/tick).
            const harvestersPerSource = Math.ceil(5 / harvesterWorkParts);

            // Calculate max harvesters based on available spots around sources
            const sources = room.find(FIND_SOURCES);
            const terrain = room.getTerrain();
            let totalHarvesterSlots = 0;

            sources.forEach(source => {
                let freeSpaces = 0;
                for (let x = source.pos.x - 1; x <= source.pos.x + 1; x++) {
                    for (let y = source.pos.y - 1; y <= source.pos.y + 1; y++) {
                        if (x === source.pos.x && y === source.pos.y) continue;
                        if (terrain.get(x, y) !== TERRAIN_MASK_WALL) {
                            freeSpaces++;
                        }
                    }
                }
                totalHarvesterSlots += Math.min(harvestersPerSource, freeSpaces);
            });
            targets.harvester_big = totalHarvesterSlots;

            // Upgraders: Scale based on Storage Energy when storage exists
            let storageEnergy = room.storage ? room.storage.store.getUsedCapacity(RESOURCE_ENERGY) : 0;
            // OR scale based on energy for spawning
            let energyForSpawning = room.energyAvailable;

            if (room.controller.level === 8) {
                targets.upgrader = 1; // Cap at 1 for RCL 8 (15 energy/tick max)
            } else {
                // Base: 1. Boost if rich.
                targets.upgrader = 1;
                if (room.storage) { // If have storage then we can start to base on this to decide our upgrade sink
                    if (storageEnergy > 100000) targets.upgrader = 2;
                    if (storageEnergy > 300000) targets.upgrader = 3;
                    if (storageEnergy > 500000) targets.upgrader = 4;
                } else { // No storage yet, use what metric to adjust?
                    // Metric: Total energy in containers
                    const containers = room.find(FIND_STRUCTURES, {
                        filter: { structureType: STRUCTURE_CONTAINER }
                    });
                    const containerEnergy = containers.reduce((sum, c) => sum + c.store.getUsedCapacity(RESOURCE_ENERGY), 0);

                    if (containerEnergy > 2000) targets.upgrader = 2;
                    if (containerEnergy > 3500) targets.upgrader = 3;
                }

                
                // Clamp for low levels to prevent starvation
                if (room.controller.level < 3) {
                    targets.upgrader = 1;
                    // Dynamic Upgrader: If energy is sitting high, allow more
                    if (room.energyAvailable > room.energyCapacityAvailable * 0.9) {
                        targets.upgrader = 2;
                    }
                }
            }

            // Builders: Scale based on Construction Sites and Repair Needs
            const sites = room.find(FIND_CONSTRUCTION_SITES).length;
            const repairs = room.find(FIND_STRUCTURES, {
                filter: (s) => {
                    if (s.structureType === STRUCTURE_ROAD) {
                        return s.hits < s.hitsMax * 0.95;
                    } else if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
                        return s.hits < 5000; // Critical defense only
                    }
                    return s.hits < s.hitsMax;
                }
            });

            // Workload calculation: 1 Site = 1 Workload, 10 Repairs = 1 Workload
            const workload = sites + (repairs.length / 10);

            if (sites > 0) {
                // If we have construction, be aggressive: min 2 builders, max 4.
                targets.builder = Math.min(Math.ceil(workload / 4) + 1, 4);
            } else {
                // If only repairs, be conservative: base 1, add more for high volume (every ~20 repairs).
                targets.builder = Math.min(Math.floor(workload / 2) + 1, 4);
            }

            // Haulers: Scale based on Source output vs Body Size
            // Calculate required carry parts based on distance
            const dropoff = room.storage || room.find(FIND_MY_SPAWNS)[0];
            if (dropoff) {
                // Initialize cache if needed
                if (!mem.pathCache || mem.pathCache.dropoffId !== dropoff.id) {
                    mem.pathCache = {
                        dropoffId: dropoff.id,
                        distances: {}
                    };
                }

                let totalCarryPartsNeeded = 0;
                sources.forEach(source => {
                    let distance = mem.pathCache.distances[source.id];

                    if (distance === undefined) {
                        const ret = PathFinder.search(source.pos, {pos: dropoff.pos, range: 1}, {
                            plainCost: 2,
                            swampCost: 10,
                            maxRooms: 1
                        });
                        if (!ret.incomplete) {
                            distance = ret.path.length;
                            mem.pathCache.distances[source.id] = distance;
                        }
                    }

                    if (distance !== undefined) {
                        // Energy generated per tick = 10 (3000 / 300)
                        // Round trip = distance * 2
                        // Capacity = 50 per CARRY part
                        // Parts needed = (10 * distance * 2) / 50 = distance * 0.4
                        // pre-spawn hauler mechanism at 50 ticks or less
                        totalCarryPartsNeeded += (distance * 0.4);
                    }
                });

                const carryPartsPerHauler = bodies.hauler.filter(p => p === CARRY).length;
                if (carryPartsPerHauler > 0) {
                    targets.hauler = Math.ceil(totalCarryPartsNeeded / carryPartsPerHauler);
                } else {
                    targets.hauler = Math.max(2, Math.ceil(numSources * 1.5));
                }
                
                // Ensure at least 1 hauler per source
                targets.hauler = Math.max(targets.hauler, numSources);
            } else {
                targets.hauler = Math.max(2, Math.ceil(numSources * 1.5));
            }
            
            // If haulers are very small (early game), we need more
            if (haulerCost < 300) targets.hauler += 1;

            // Special Controller Hauler
            const controllerContainer = room.controller.pos.findInRange(FIND_STRUCTURES, 3, {
                filter: { structureType: STRUCTURE_CONTAINER }
            });
            if (room.storage && controllerContainer.length > 0) {
                targets.hauler_controller_special = 1;
            }
        } else {
            // Recovery Mode (Has some harvesters, but not full saturation)
            targets.builder = 1;
            targets.hauler = 1;
        }

        log(`[Economy] ${room.name} Budget: ${energyBudget} (Emergency: ${isEmergency}) Targets: ${JSON.stringify(targets)} Bodies: ${JSON.stringify(bodies)}`);
        
        const result = {
            targets: targets,
            bodies: bodies,
            state: {
                isEmergency: isEmergency,
                energyBudget: energyBudget
            }
        };

        // Update Cache
        mem.plan = result;
        mem.lastTick = Game.time;
        mem.lastRCL = room.controller.level;
        mem.lastCapacity = room.energyCapacityAvailable;
        mem.wasEmergency = isEmergency;

        return result;
    }
};
