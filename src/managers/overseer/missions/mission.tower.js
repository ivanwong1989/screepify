module.exports = {
    generate: function(room, intel, context, missions) {
        // --- Priority 0: Defense ---
        if (intel.hostiles.length > 0) {
            missions.push({
                name: 'tower:defense',
                type: 'tower_attack',
                targetIds: intel.hostiles.map(c => c.id),
                priority: 1000
            });
        }

        // --- Priority 0.5: Heal ---
        const damagedCreeps = intel.myCreeps.filter(c => c.hits < c.hitsMax);
        if (damagedCreeps.length > 0) {
            missions.push({
                name: 'tower:heal',
                type: 'tower_heal',
                targetIds: damagedCreeps.map(c => c.id),
                priority: 950
            });
        }

        // --- Priority 4.5: Repair ---
        // Only if we have reasonable energy and normal repair creep missions fail to keep up, meaning very lot HP
        if (intel.energyAvailable > intel.energyCapacityAvailable * 0.5) {
            const allStructures = [].concat(...Object.values(intel.structures));
            const damagedStructures = allStructures.filter(s => 
                s.hits < s.hitsMax &&
                (s.hits / s.hitsMax) < 0.6 && 
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
    }
};
