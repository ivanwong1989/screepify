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
        const storage = room.storage;
        const terminal = room.terminal;
        
        const containerEnergy = containers.reduce((sum, c) => sum + c.store[RESOURCE_ENERGY], 0);
        const containerCapacity = containers.reduce((sum, c) => sum + c.store.getCapacity(RESOURCE_ENERGY), 0);
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
            const nearbyContainers = containers.filter(c => c.pos.inRangeTo(source.pos, 1));

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
                hasContainer: nearbyContainers.length > 0,
                containerId: nearbyContainers.length > 0 ? nearbyContainers[0].id : null,
                availableSpaces: availableSpaces
            };
        });

        const minerals = (cache.minerals || []).map(mineral => {
            const nearbyContainers = containers.filter(c => c.pos.inRangeTo(mineral.pos, 1));
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
                hasContainer: nearbyContainers.length > 0,
                containerId: nearbyContainers.length > 0 ? nearbyContainers[0].id : null,
                availableSpaces: availableSpaces
            };
        });

        let controllerSpaces = 0;
        let controllerContainerId = null;
        if (room.controller) {
            for (let x = -1; x <= 1; x++) {
                for (let y = -1; y <= 1; y++) {
                    if (x === 0 && y === 0) continue;
                    const t = terrain.get(room.controller.pos.x + x, room.controller.pos.y + y);
                    if (t !== TERRAIN_MASK_WALL) controllerSpaces++;
                }
            }
            const controllerContainers = containers.filter(c => room.controller.pos.inRangeTo(c.pos, 3));
            if (controllerContainers.length > 0) controllerContainerId = controllerContainers[0].id;
        }

        return {
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
    },

    determineState: function(room, intel) {
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
        if (!room.memory.overseer.economyFlow) {
            room.memory.overseer.economyFlow = {
                avg: 0,
                lastTotal: totalStored,
                lastTick: Game.time,
                lastLogTotal: totalStored,
                lastLogTick: Game.time
            };
        }
        const flow = room.memory.overseer.economyFlow;
        const dt = Math.max(1, Game.time - (flow.lastTick || Game.time));
        const delta = totalStored - (flow.lastTotal || totalStored);
        const perTick = delta / dt;
        const ALPHA = 0.2; // smoothing factor for EMA
        flow.avg = (flow.avg === undefined || flow.avg === null) ? perTick : ((flow.avg * (1 - ALPHA)) + (perTick * ALPHA));
        flow.lastTotal = totalStored;
        flow.lastTick = Game.time;
        room.memory.overseer.economyFlow = flow;

        const FLOW_POSITIVE = 2;
        const FLOW_NEGATIVE = -2;

        if (Game.time % 50 === 0) {
            const logDt = Math.max(1, Game.time - (flow.lastLogTick || Game.time));
            const logDelta = totalStored - (flow.lastLogTotal || totalStored);
            const logPerTick = logDelta / logDt;
            flow.lastLogTotal = totalStored;
            flow.lastLogTick = Game.time;
            room.memory.overseer.economyFlow = flow;
            debug('overseer', `[Overseer] ${room.name} Flow: total=${totalStored} tickDelta=${delta} tickDt=${dt} tickPerTick=${perTick.toFixed(2)} windowDelta=${logDelta} windowDt=${logDt} windowPerTick=${logPerTick.toFixed(2)} avg=${flow.avg.toFixed(2)}`);
        }
        
        if (totalCapacity < 500) return 'UPGRADING';

        if (room.storage) {
            const UPGRADE_START = 50000;
            const UPGRADE_STOP = 10000;
            if (current === 'STOCKPILING' && totalStored >= UPGRADE_START && flow.avg >= FLOW_POSITIVE) current = 'UPGRADING';
            else if (current === 'UPGRADING' && (totalStored <= UPGRADE_STOP || flow.avg <= FLOW_NEGATIVE)) current = 'STOCKPILING';
        } else {
            const UPGRADE_START = totalCapacity * 0.8;
            const UPGRADE_STOP = totalCapacity * 0.2;
            if (current === 'STOCKPILING' && totalStored >= UPGRADE_START && flow.avg >= FLOW_POSITIVE) current = 'UPGRADING';
            else if (current === 'UPGRADING' && (totalStored <= UPGRADE_STOP || flow.avg <= FLOW_NEGATIVE)) current = 'STOCKPILING';
        }
        
        return current;
    }
};

module.exports = overseerIntel;
