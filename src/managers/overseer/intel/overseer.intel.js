/**
 * Overseer Intel Module
 * Handles data gathering and room state determination.
 */
const overseerIntel = {
    gather: function(room) {
        const cache = global.getRoomCache(room);
        const terrain = room.getTerrain();
        const myCreeps = cache.myCreeps || [];
        const structures = cache.structuresByType || {};
        const dropped = cache.dropped || [];
        const ruins = cache.ruins || [];
        const tombstones = (cache.tombstones || []).filter(t => t && t.store && t.store.getUsedCapacity() > 0);
        const flags = cache.flags || [];
        
        const containers = structures[STRUCTURE_CONTAINER] || [];
        const extractors = structures[STRUCTURE_EXTRACTOR] || [];

        // --- Per-tick position lookup maps (cheap, O(n)) ---
        const posKey = (x, y) => `${x},${y}`;

        const containerIdByPos = Object.create(null);
        for (const c of containers) {
            const key = posKey(c.pos.x, c.pos.y);
            // preserve first container found (same behavior as filter()[0])
            if (containerIdByPos[key] === undefined) {
                containerIdByPos[key] = c.id;
            }
        }

        const links = structures[STRUCTURE_LINK] || [];
        const linkIdByPos = Object.create(null);
        for (const l of links) {
            const key = posKey(l.pos.x, l.pos.y);
            if (linkIdByPos[key] === undefined) {
                linkIdByPos[key] = l.id;
            }
        } 

        const storage = room.storage;
        const terminal = room.terminal;
        
        let containerEnergy = 0;
        let containerCapacity = 0;
        for (const c of containers) {
            containerEnergy += (c.store[RESOURCE_ENERGY] || 0);
            containerCapacity += c.store.getCapacity(RESOURCE_ENERGY);
        }
        const storageEnergy = storage ? storage.store[RESOURCE_ENERGY] : 0;
        const storageCapacity = storage ? storage.store.getCapacity(RESOURCE_ENERGY) : 0;
        const terminalEnergy = terminal ? terminal.store[RESOURCE_ENERGY] : 0;
        const terminalCapacity = terminal ? terminal.store.getCapacity(RESOURCE_ENERGY) : 0;

        const logisticsCreeps = myCreeps.filter(c => 
            c.memory.missionName && c.memory.missionName.includes('logistics')
        );
        const haulerCapacity = logisticsCreeps.reduce((sum, c) => sum + c.store.getCapacity(RESOURCE_ENERGY), 0);

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
            if (t.store[RESOURCE_ENERGY] > 0) {
                allEnergySources.push({ id: t.id, pos: t.pos, amount: t.store[RESOURCE_ENERGY], type: 'tombstone' });
            }
        });
        
        const sources = (cache.sources || []).map(source => {
            // Check 8 adjacent tiles for container
            let containerId = null;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (dx === 0 && dy === 0) continue;
                    const id = containerIdByPos[posKey(source.pos.x + dx, source.pos.y + dy)];
                    if (id) {
                        containerId = id;
                        break;
                    }
                }
                if (containerId) break;
            }

            // Check 5x5 area for link (range 2)
            let linkId = null;
            for (let dx = -2; dx <= 2; dx++) {
                for (let dy = -2; dy <= 2; dy++) {
                    if (dx === 0 && dy === 0) continue;
                    const id = linkIdByPos[posKey(source.pos.x + dx, source.pos.y + dy)];
                    if (id) {
                        linkId = id;
                        break;
                    }
                }
                if (linkId) break;
            }

            let availableSpaces = 0;
            for (let x = -1; x <= 1; x++) {
                for (let y = -1; y <= 1; y++) {
                    if (x === 0 && y === 0) continue;
                    const t = terrain.get(source.pos.x + x, source.pos.y + y);
                    if (t !== TERRAIN_MASK_WALL) availableSpaces++;
                }
            }

            return {
                id: source.id,
                pos: source.pos,
                energy: source.energy,
                energyCapacity: source.energyCapacity,
                hasContainer: !!containerId,
                containerId: containerId,
                linkId: linkId,
                availableSpaces: availableSpaces
            };
        });

        const minerals = (cache.minerals || []).map(mineral => {
            // Check 8 adjacent tiles for container (same as source logic)
            let containerId = null;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (dx === 0 && dy === 0) continue;
                    const id = containerIdByPos[posKey(mineral.pos.x + dx, mineral.pos.y + dy)];
                    if (id) {
                        containerId = id;
                        break;
                    }
                }
                if (containerId) break;
            }
            const extractor = extractors.find(e => e.pos.isEqualTo(mineral.pos));

            let availableSpaces = 0;
            for (let x = -1; x <= 1; x++) {
                for (let y = -1; y <= 1; y++) {
                    if (x === 0 && y === 0) continue;
                    const t = terrain.get(mineral.pos.x + x, mineral.pos.y + y);
                    if (t !== TERRAIN_MASK_WALL) availableSpaces++;
                }
            }

            return {
                id: mineral.id,
                pos: mineral.pos,
                mineralType: mineral.mineralType,
                mineralAmount: mineral.mineralAmount,
                ticksToRegeneration: mineral.ticksToRegeneration || 0,
                hasExtractor: !!extractor,
                extractorId: extractor ? extractor.id : null,
                hasContainer: !!containerId,
                containerId: containerId,
                availableSpaces: availableSpaces
            };
        });

        let controllerSpaces = 0;
        let controllerContainerId = null;
        if (room.controller) {
            const cPos = room.controller.pos;

            controllerSpaces = 0;
            controllerContainerId = null;

            // Single 7x7 scan: count spaces + find container via lookup
            for (let dx = -3; dx <= 3; dx++) {
                for (let dy = -3; dy <= 3; dy++) {
                    if (dx === 0 && dy === 0) continue;

                    const cx = cPos.x + dx;
                    const cy = cPos.y + dy;

                    if (cx < 0 || cx > 49 || cy < 0 || cy > 49) continue;

                    const t = terrain.get(cx, cy);
                    if (t !== TERRAIN_MASK_WALL) controllerSpaces++;

                    // container lookup (O(1))
                    if (!controllerContainerId) {
                        const id = containerIdByPos[posKey(cx, cy)];
                        if (id) controllerContainerId = id;
                    }
                }
            }
        }

        const intel = {
            sources, minerals, myCreeps, hostiles: cache.hostiles || [],
            constructionSites: cache.constructionSites || [],
            structures, dropped, ruins, flags, tombstones,
            controller: room.controller, controllerContainerId,
            availableControllerSpaces: controllerSpaces,
            energyAvailable: room.energyAvailable,
            energyCapacityAvailable: room.energyCapacityAvailable,
            containerEnergy, containerCapacity, storageEnergy, storageCapacity,
            terminalEnergy, terminalCapacity, hasTerminal: !!terminal,
            haulerCapacity, allEnergySources
        };

        // Economy is computed in intel and should be treated as the source of truth downstream.
        intel.economyState = this.determineEconomyState(room, intel);
        intel.economyFlow = (room.memory.overseer && room.memory.overseer.economyFlow) || { avg: 0, longAvg: 0 };

        return intel;
    },

    determineOpState: function(room, intel) {
        if (intel.myCreeps.length === 0) {
            debug('overseer', `[Overseer] ${room.name} State: EMERGENCY (Zero Population)`);
            return 'EMERGENCY';
        }
        if (intel.energyAvailable < 300 && intel.myCreeps.length < 2) {
            debug('overseer', `[Overseer] ${room.name} State: EMERGENCY (Low Energy: ${intel.energyAvailable}, Low Pop: ${intel.myCreeps.length})`);
            return 'EMERGENCY';
        }
        const miners = intel.myCreeps.filter(c => c.memory.role === 'miner');
        if (miners.length === 0 && intel.sources.length > 0) {
            debug('overseer', `[Overseer] ${room.name} State: EMERGENCY (No Miners)`);
            return 'EMERGENCY';
        }
        return 'NORMAL';
    },

    determineEconomyState: function(room, intel) {
        if (!room.memory.overseer) room.memory.overseer = {};
        let current = (room.memory.overseer && room.memory.overseer.economyState) || 'STOCKPILING';
        const miningContainerIds = new Set(intel.sources.map(s => s.containerId).filter(id => id));
        const allContainers = intel.structures[STRUCTURE_CONTAINER] || [];
        const logisticsContainers = allContainers.filter(c => !miningContainerIds.has(c.id));
        
        const logisticsEnergy = logisticsContainers.reduce((sum, c) => sum + c.store[RESOURCE_ENERGY], 0);
        const logisticsCapacity = logisticsContainers.reduce((sum, c) => sum + c.store.getCapacity(RESOURCE_ENERGY), 0);

        const totalStored = logisticsEnergy + intel.storageEnergy;
        const totalCapacity = logisticsCapacity + intel.storageCapacity;

        // Track net energy flow (in/out of logistics + storage) to inform state changes.
        // We DO NOT sample every tick (too noisy with batch hauling). Instead we sample every N ticks,
        // compute a per-tick rate over that window, then EMA it with a low alpha for long horizon.
        const SAMPLE_TICKS = 20;     // <-- feature #1: sample period
        const ALPHA = 0.02;         // <-- feature #2: long-horizon EMA (less jumpy)

        if (!room.memory.overseer.economyFlow) {
            room.memory.overseer.economyFlow = {
                avg: 0,
                longAvg: 0,

                // sampling state
                lastSampleTotal: totalStored,
                lastSampleTick: Game.time,

                // last computed sample (for logs/debug)
                lastPerTick: 0,
                lastDelta: 0,
                lastDt: 0,

                // logging window state
                lastLogTotal: totalStored,
                lastLogTick: Game.time
            };
        }

        const flow = room.memory.overseer.economyFlow;

        // Normalize legacy/partial memory (prevents 'undefined' in logs and weird dt math)
        if (flow.lastSampleTotal === undefined) flow.lastSampleTotal = totalStored;
        if (flow.lastSampleTick === undefined) flow.lastSampleTick = Game.time;
        if (flow.lastPerTick === undefined) flow.lastPerTick = 0;
        if (flow.lastDelta === undefined) flow.lastDelta = 0;
        if (flow.lastDt === undefined) flow.lastDt = 0;
        if (flow.lastLogTotal === undefined) flow.lastLogTotal = totalStored;
        if (flow.lastLogTick === undefined) flow.lastLogTick = Game.time;
        if (flow.avg === undefined || flow.avg === null || Number.isNaN(flow.avg)) flow.avg = 0;
        if (flow.longAvg === undefined || flow.longAvg === null || Number.isNaN(flow.longAvg)) flow.longAvg = flow.avg;

        // only compute a new sample every SAMPLE_TICKS (or on first init)
        const since = Game.time - (flow.lastSampleTick || Game.time);
        if (since >= SAMPLE_TICKS) {
            const dt = Math.max(1, Game.time - (flow.lastSampleTick || Game.time));
            const delta = totalStored - (flow.lastSampleTotal || totalStored);
            const perTick = delta / dt;

            flow.lastPerTick = perTick;
            flow.lastDelta = delta;
            flow.lastDt = dt;

            // EMA update on sampled perTick (long horizon)
            flow.avg = (flow.avg === undefined || flow.avg === null)
                ? perTick
                : ((flow.avg * (1 - ALPHA)) + (perTick * ALPHA));

            flow.longAvg = flow.avg;

            flow.lastSampleTotal = totalStored;
            flow.lastSampleTick = Game.time;

            room.memory.overseer.economyFlow = flow;
        }

        const FLOW_POSITIVE = 2;
        const FLOW_NEGATIVE = -2;

        // Log every 50 ticks; report the most recent sampled perTick + EMA
        if (Game.time % 50 === 0 && flow._lastLoggedAt !== Game.time) {
            flow._lastLoggedAt = Game.time;
            const logDt = Math.max(1, Game.time - (flow.lastLogTick || Game.time));
            const logDelta = totalStored - (flow.lastLogTotal || totalStored);
            const logPerTick = logDelta / logDt;

            flow.lastLogTotal = totalStored;
            flow.lastLogTick = Game.time;
            room.memory.overseer.economyFlow = flow;

            debug(
                'overseer',
                `[Overseer] ${room.name} Flow: total=${totalStored} ` +
                `sampleDt=${flow.lastDt} sampleDelta=${flow.lastDelta} samplePerTick=${(flow.lastPerTick || 0).toFixed(2)} ` +
                `windowDt=${logDt} windowDelta=${logDelta} windowPerTick=${logPerTick.toFixed(2)} ` +
                `avg=${(flow.avg || 0).toFixed(2)}`
            );
        }

        const override = room.memory.overseer.economyOverride;
        const normalized = override ? ('' + override).trim().toUpperCase() : '';
        if (normalized === 'UPGRADING' || normalized === 'STOCKPILING') return normalized;
        
        if (totalCapacity < 500) return 'UPGRADING';

        if (room.storage) {
            const rcl = (room.controller && room.controller.level) ? room.controller.level : 1;
            const rclThresholds = {
                1: { start: 10000, stop: 5000 },
                2: { start: 20000, stop: 10000 },
                3: { start: 30000, stop: 15000 },
                4: { start: 40000, stop: 20000 },
                5: { start: 100000, stop: 80000 },
                6: { start: 200000, stop: 150000 },
                7: { start: 500000, stop: 450000 },
                8: { start: 700000, stop: 500000 }
            };
            const threshold = rclThresholds[rcl] || rclThresholds[5];
            const UPGRADE_START = threshold.start;
            const UPGRADE_STOP = threshold.stop;
            if (current === 'STOCKPILING' && totalStored >= UPGRADE_START) current = 'UPGRADING';
            else if (current === 'UPGRADING' && (totalStored <= UPGRADE_STOP)) current = 'STOCKPILING';
        } else { // Without storage, the flow tracking is too undeterministic since there's no buffer. do not use flow EMA.
            // Also most probably without storage means low RCL. focus should be on upgrading still we have. 
            // We should always we in UPGRADING mode. 
            current = 'UPGRADING';
        }
        room.memory.overseer.economyState = current;
        return current;
    }
};

module.exports = overseerIntel;
