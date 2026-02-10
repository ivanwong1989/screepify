const managerSpawner = require('managers_manager.room.economy.spawner');

module.exports = {
    generate: function(room, intel, context, missions) {
        const { state, economyState, budget, getMissionCensus } = context;
        if (!intel.controller || !intel.controller.my || state === 'EMERGENCY') return;

        let upgradePriority = 50;
        let desiredWork = 5;

        if (economyState === 'STOCKPILING') {
            desiredWork = 1;
            upgradePriority = 10;
            if (intel.controller.ticksToDowngrade < 5000) upgradePriority = 100;
        } else if (intel.energyAvailable === intel.energyCapacityAvailable) {
            upgradePriority = 80;
            desiredWork = 15;
        }

        if (intel.constructionSites.length > 0) {
            desiredWork = 1;
            upgradePriority = 20;
        }

        const upName = 'upgrade:controller';
        const upCensus = getMissionCensus(upName);
        const upStats = managerSpawner.checkBody('worker', budget);
        const upDeficit = Math.max(0, desiredWork - upCensus.work);
        const upNeeded = Math.ceil(upDeficit / (upStats.work || 1));
        let upCount = Math.min(upCensus.count + upNeeded, intel.availableControllerSpaces);

        if (intel.constructionSites.length > 0) {
            upCount = Math.ceil(desiredWork / (upStats.work || 1));
            if (desiredWork > 0 && upCount < 1) upCount = 1;
        }

        missions.push({
            name: upName,
            type: 'upgrade',
            archetype: 'worker',
            targetId: intel.controller.id,
            data: { sourceIds: intel.allEnergySources.map(s => s.id) },
            pos: intel.controller.pos,
            requirements: { archetype: 'worker', count: upCount },
            priority: upgradePriority
        });
    }
};
