const managerSpawner = require('managers_spawner_manager.room.economy.spawner');

module.exports = {
    generate: function(room, intel, context, missions) {
        const { opState, economyState, budget, getMissionCensus, economyFlow } = context;
        if (!intel.controller || !intel.controller.my || opState === 'EMERGENCY') return;

        const ticksToDowngrade = intel.controller.ticksToDowngrade || 0;
        const CRITICAL_DOWNGRADE_TICKS = 5000;
        const isCritical = ticksToDowngrade < CRITICAL_DOWNGRADE_TICKS;

        let upgradePriority = 50;
        let desiredWork = 5;
        let spawnAllowed = true;

        if (economyState === 'STOCKPILING') {
            desiredWork = 1;                 // keep minimal trickle if existing creeps exist
            upgradePriority = 10;
            spawnAllowed = isCritical;       // ONLY spawn if downgrade critical
            if (isCritical) upgradePriority = 100;
        }

        if (intel.constructionSites.length > 0) {
            desiredWork = 1;
            upgradePriority = 20;
        }

        const upName = 'upgrade:controller';
        const upCensus = getMissionCensus(upName);
        const upStats = managerSpawner.checkBody('worker', budget);
        const workPerCreep = upStats.work || 1;
        const desiredCount = Math.min(Math.ceil(desiredWork / workPerCreep), intel.availableControllerSpaces);

        let upCount = 0;
        if (upCensus.workParts >= desiredWork) {
            upCount = Math.max(1, desiredCount);
        } else {
            const upDeficit = Math.max(0, desiredWork - upCensus.workParts);
            const upNeeded = Math.ceil(upDeficit / workPerCreep);
            upCount = Math.min(upCensus.count + upNeeded, intel.availableControllerSpaces);
            if (!(economyState === 'STOCKPILING' && !isCritical) && desiredWork > 0 && upCount < 1) upCount = 1;
        }

        if (intel.constructionSites.length > 0) {
            upCount = Math.max(1, desiredCount);
        }

        // Persist existing upgraders until creep death (do not de-assign by collapsing the requirement).
        // While stockpiling, we normally stop spawning new upgraders unless the stockpile window is open.
        if (economyState === 'STOCKPILING' && !isCritical) {
            // Keep existing upgraders only. Do not spawn new ones.
            upCount = Math.min(upCensus.count, intel.availableControllerSpaces);
        }

        debug('mission.upgrade', `[Upgrade] ${room.name} count=${upCensus.count} workParts=${upCensus.workParts}/${desiredWork} ` +
            `workPerCreep=${workPerCreep} desired=${desiredCount} req=${upCount} ` +
            `spaces=${intel.availableControllerSpaces} state=${economyState}`);

        missions.push({
            name: upName,
            type: 'upgrade',
            archetype: 'worker',
            targetId: intel.controller.id,
            data: { sourceIds: intel.allEnergySources.map(s => s.id) },
            pos: intel.controller.pos,
            requirements: { archetype: 'worker', count: upCount, spawn: spawnAllowed, spawnFromFleet: true },
            priority: upgradePriority
        });
    }
};
