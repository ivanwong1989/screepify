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

        const extractorIdByPos = Object.create(null);
        for (const e of extractors) {
            const key = posKey(e.pos.x, e.pos.y);
            if (extractorIdByPos[key] === undefined) {
                extractorIdByPos[key] = e.id;
            }
        }

        const storage = room.storage;
        const terminal = room.terminal;
        const allEnergySources = [];
        
        let containerEnergy = 0;
        let containerCapacity = 0;
        for (const c of containers) {
            const energy = c.store[RESOURCE_ENERGY] || 0;
            containerEnergy += energy;
            containerCapacity += c.store.getCapacity(RESOURCE_ENERGY);
            if (energy > 0) {
                allEnergySources.push({ id: c.id, pos: c.pos, amount: energy, type: 'container' });
            }
        }
        const storageEnergy = storage ? storage.store[RESOURCE_ENERGY] : 0;
        const storageCapacity = storage ? storage.store.getCapacity(RESOURCE_ENERGY) : 0;
        const terminalEnergy = terminal ? terminal.store[RESOURCE_ENERGY] : 0;
        const terminalCapacity = terminal ? terminal.store.getCapacity(RESOURCE_ENERGY) : 0;

        const logisticsCreeps = myCreeps.filter(c => 
            c.memory.missionName && c.memory.missionName.includes('logistics')
        );
        const haulerCapacity = logisticsCreeps.reduce((sum, c) => sum + c.store.getCapacity(RESOURCE_ENERGY), 0);

        if (storageEnergy > 0 && storage) {
            allEnergySources.push({ id: storage.id, pos: storage.pos, amount: storageEnergy, type: 'storage' });
        }
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
            const extractorId = extractorIdByPos[posKey(mineral.pos.x, mineral.pos.y)] || null;

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
                hasExtractor: !!extractorId,
                extractorId: extractorId,
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

        intel.roomState = room && room._policy && room._policy.state ? room._policy.state : null;
        intel.economyFlow = (room.memory.overseer && room.memory.overseer.economyFlow) || { avg: 0, longAvg: 0 };

        return intel;
    }
};

module.exports = overseerIntel;
