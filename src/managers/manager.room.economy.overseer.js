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

        // 3. Determine State
        // Priority: Emergency > Defense > Growth > Stable
        let state = 'STABLE';
        if (isEmergency) state = 'EMERGENCY';
        else if (underAttack) state = 'DEFENSE';
        else if (hasConstruction) state = 'GROWTH';

        // 4. Determine Strategies (Mining, etc.)
        this.determineStrategies(room, brain);

        // 5. Publish to Memory (for Tasks and Spawner to read)
        brain.state = state;
        brain.needs = {
            repair: needsRepair,
            build: hasConstruction,
            hostiles: underAttack
        };
        
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
    }
};
