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
        const tombstones = (cache.tombstones || []).filter(t => t.store[RESOURCE_ENERGY] > 0);
        const flags = cache.flags || [];
        
        const containers = structures[STRUCTURE_CONTAINER] || [];
        const storage = room.storage;
        
        const containerEnergy = containers.reduce((sum, c) => sum + c.store[RESOURCE_ENERGY], 0);
        const containerCapacity = containers.reduce((sum, c) => sum + c.store.getCapacity(RESOURCE_ENERGY), 0);
        const storageEnergy = storage ? storage.store[RESOURCE_ENERGY] : 0;
        const storageCapacity = storage ? storage.store.getCapacity(RESOURCE_ENERGY) : 0;

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
            allEnergySources.push({ id: t.id, pos: t.pos, amount: t.store[RESOURCE_ENERGY], type: 'tombstone' });
        });
        
        const sources = room.find(FIND_SOURCES).map(source => {
            const containers = source.pos.findInRange(FIND_STRUCTURES, 1, {
                filter: s => s.structureType === STRUCTURE_CONTAINER
            });

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
                hasContainer: containers.length > 0,
                containerId: containers.length > 0 ? containers[0].id : null,
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
            const containers = room.controller.pos.findInRange(FIND_STRUCTURES, 3, {
                filter: s => s.structureType === STRUCTURE_CONTAINER
            });
            if (containers.length > 0) controllerContainerId = containers[0].id;
        }

        return {
            sources, myCreeps, hostiles: cache.hostiles || [],
            constructionSites: cache.constructionSites || [],
            structures, dropped, ruins, flags, tombstones,
            controller: room.controller, controllerContainerId,
            availableControllerSpaces: controllerSpaces,
            energyAvailable: room.energyAvailable,
            energyCapacityAvailable: room.energyCapacityAvailable,
            containerEnergy, containerCapacity, storageEnergy, storageCapacity,
            haulerCapacity, allEnergySources
        };
    },

    determineState: function(room, intel) {
        if (intel.myCreeps.length === 0 || (intel.energyAvailable < 300 && intel.myCreeps.length < 2)) {
            return 'EMERGENCY';
        }
        const miners = intel.myCreeps.filter(c => c.memory.role === 'miner');
        if (miners.length === 0 && intel.sources.length > 0) {
            return 'EMERGENCY';
        }
        if (room.find(FIND_HOSTILE_CREEPS).length > 0) {
            return 'DEFENSE';
        }
        return 'NORMAL';
    },

    determineEconomyState: function(room, intel) {
        let current = (room.memory.overseer && room.memory.overseer.economyState) || 'STOCKPILING';
        const miningContainerIds = new Set(intel.sources.map(s => s.containerId).filter(id => id));
        const allContainers = intel.structures[STRUCTURE_CONTAINER] || [];
        const logisticsContainers = allContainers.filter(c => !miningContainerIds.has(c.id));
        
        const logisticsEnergy = logisticsContainers.reduce((sum, c) => sum + c.store[RESOURCE_ENERGY], 0);
        const logisticsCapacity = logisticsContainers.reduce((sum, c) => sum + c.store.getCapacity(RESOURCE_ENERGY), 0);

        const totalStored = logisticsEnergy + intel.storageEnergy;
        const totalCapacity = logisticsCapacity + intel.storageCapacity;
        
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
    }
};

module.exports = overseerIntel;
