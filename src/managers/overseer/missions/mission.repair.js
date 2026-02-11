const managerSpawner = require('managers_spawner_manager.room.economy.spawner');

module.exports = {
    generate: function(room, intel, context, missions) {
        const { state, budget, getMissionCensus } = context;
        if (state === 'EMERGENCY') return;

        const repairTargets = [];
        const allStructures = [].concat(...Object.values(intel.structures));
        
        const decayables = allStructures.filter(s => 
            (s.structureType === STRUCTURE_ROAD || s.structureType === STRUCTURE_CONTAINER) && s.hits < s.hitsMax
        );
        const others = allStructures.filter(s => 
            s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_CONTAINER &&
            s.structureType !== STRUCTURE_WALL && s.structureType !== STRUCTURE_RAMPART && s.hits < s.hitsMax
        );
        const forts = allStructures.filter(s => 
            (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) && s.hits < 100000
        );

        repairTargets.push(...decayables, ...others, ...forts);
        if (repairTargets.length === 0) return;

        const repairName = 'repair:structures';
        const repairCensus = getMissionCensus(repairName);
        const repairStats = managerSpawner.checkBody('worker', budget);
        
        let repairWorkTarget = repairTargets.length > 10 ? 10 : 5;
        const repairDeficit = Math.max(0, repairWorkTarget - repairCensus.workParts);
        const repairNeeded = Math.ceil(repairDeficit / (repairStats.work || 1));

        missions.push({
            name: repairName,
            type: 'repair',
            archetype: 'worker',
            targetIds: repairTargets.map(s => s.id),
            data: { sourceIds: intel.allEnergySources.map(s => s.id) },
            requirements: {
                archetype: 'worker',
                count: repairCensus.count + repairNeeded
            },
            priority: 65
        });
    }
};
