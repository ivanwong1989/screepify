'use strict';

module.exports = function resolveEnergySource(creep, room, options, deps) {
    // Ensure reservation table exists (safety check)
    if (!room._reservedEnergy) room._reservedEnergy = {};
    const cache = global.getRoomCache(room);

    const allowedIds = options.allowedIds || null;
    const excludeIds = options.excludeIds || [];
    const preferNearestAvailable = !!options.preferNearestAvailable;

    // 0. Specific Allowed Sources (Tight Logistics)
    if (allowedIds && allowedIds.length > 0) {
        const targets = allowedIds.map(id => deps.getCachedObject(creep.room, id)).filter(t => t);
        // Find closest valid target from the allowed list
        const valid = targets.filter(t => {
            if (excludeIds.includes(t.id)) return false;
            
            // Check energy availability
            let amount = 0;
            if (t instanceof Resource) amount = t.amount;
            else if (t.store) amount = t.store[RESOURCE_ENERGY];
            
            // Reserve check
            const reserved = room._reservedEnergy[t.id] || 0;
            return (amount - reserved) > 0;
        });

        const target = creep.pos.findClosestByRange(valid);
        if (target) {
            room._reservedEnergy[target.id] = (room._reservedEnergy[target.id] || 0) + creep.store.getFreeCapacity();
            if (target instanceof Resource) return { action: 'pickup', targetId: target.id };
            return { action: 'withdraw', targetId: target.id, resourceType: RESOURCE_ENERGY };
        }
        
        if (creep.store[RESOURCE_ENERGY] > 0) {
            creep.memory.taskState = 'working';
        }
        
        // If restricted to specific sources and none are available, return null (idle)
        return null;
    }

    if (preferNearestAvailable) {
        const candidates = [];
        const candidateById = new Map();

        // Dropped energy
        (cache.dropped || []).forEach(r => {
            if (r.resourceType !== RESOURCE_ENERGY || r.amount <= 50) return;
            if (excludeIds.includes(r.id)) return;
            const reserved = room._reservedEnergy[r.id] || 0;
            if ((r.amount - reserved) < 50) return;
            const entry = { target: r, action: 'pickup' };
            candidates.push(r);
            candidateById.set(r.id, entry);
        });

        // Containers / Storage / Links
        const storageAndContainers = [
            ...(cache.structuresByType[STRUCTURE_CONTAINER] || []),
            ...(cache.structuresByType[STRUCTURE_STORAGE] || []),
            ...(cache.structuresByType[STRUCTURE_LINK] || [])
        ];
        storageAndContainers.forEach(s => {
            if (allowedIds && !allowedIds.includes(s.id)) return;
            if (excludeIds.includes(s.id)) return;
            const energy = s.store[RESOURCE_ENERGY];
            const reserved = room._reservedEnergy[s.id] || 0;
            if ((energy - reserved) < 50) return;
            const entry = { target: s, action: 'withdraw' };
            candidates.push(s);
            candidateById.set(s.id, entry);
        });

        const closest = creep.pos.findClosestByRange(candidates);
        if (closest) {
            room._reservedEnergy[closest.id] = (room._reservedEnergy[closest.id] || 0) + creep.store.getFreeCapacity();
            const chosen = candidateById.get(closest.id);
            if (chosen && chosen.action === 'pickup') {
                return { action: 'pickup', targetId: closest.id };
            }
            return { action: 'withdraw', targetId: closest.id, resourceType: RESOURCE_ENERGY };
        }
    } else {
        // 1. Pickup Dropped
        const dropped = creep.pos.findClosestByRange(cache.dropped || [], {
            filter: r => {
                if (r.resourceType !== RESOURCE_ENERGY || r.amount <= 50) return false;
                if (excludeIds.includes(r.id)) return false;
                const reserved = room._reservedEnergy[r.id] || 0;
                // Only target if there is enough energy remaining after other creeps take their share
                return (r.amount - reserved) >= 50;
            }
        });
        if (dropped) {
            // Reserve the amount this creep will take (up to its capacity)
            room._reservedEnergy[dropped.id] = (room._reservedEnergy[dropped.id] || 0) + creep.store.getFreeCapacity();
            return { action: 'pickup', targetId: dropped.id };
        }

        // 2. Withdraw from Container/Storage
        const storageAndContainers = [
            ...(cache.structuresByType[STRUCTURE_CONTAINER] || []),
            ...(cache.structuresByType[STRUCTURE_STORAGE] || []),
            ...(cache.structuresByType[STRUCTURE_LINK] || [])
        ];
        const validStructures = storageAndContainers.filter(s => {
            if (allowedIds && !allowedIds.includes(s.id)) return false;
            if (excludeIds.includes(s.id)) return false;
            const energy = s.store[RESOURCE_ENERGY];
            const reserved = room._reservedEnergy[s.id] || 0;
            return (energy - reserved) >= 50;
        });
        const structure = creep.pos.findClosestByRange(validStructures);
        if (structure) {
            room._reservedEnergy[structure.id] = (room._reservedEnergy[structure.id] || 0) + creep.store.getFreeCapacity();
            return { action: 'withdraw', targetId: structure.id, resourceType: RESOURCE_ENERGY };
        }
    }

    // 3. Harvest (if capable)
    if (creep.getActiveBodyparts(WORK) > 0) {
        const source = creep.pos.findClosestByRange(cache.sourcesActive || []);
        if (source) {
            return { action: 'harvest', targetId: source.id };
        }
    }
    return null;
};
