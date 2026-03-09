module.exports = {
    generate: function(room, intel, context, missions) {
        const { opState, economyState, budget, getMissionCensus, economyFlow } = context;
        if (!intel.controller || !intel.controller.my || opState === 'EMERGENCY') return;

        const ticksToDowngrade = intel.controller.ticksToDowngrade || 0;
        const CRITICAL_DOWNGRADE_TICKS = 5000;
        const isCritical = ticksToDowngrade < CRITICAL_DOWNGRADE_TICKS;

        let upgradePriority = 50;
        let desiredWork = 10;
        if (room.controller.level < 3) {
            // Early RCL rush to Tower defense
            desiredWork = 15;
        }
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
        let requiredWork = desiredWork;
        let minCount = (desiredWork > 0) ? 1 : 0;
        let maxCount = intel.availableControllerSpaces;

        // Persist existing upgraders until creep death (do not de-assign by collapsing the requirement).
        // While stockpiling, we normally stop spawning new upgraders unless the stockpile window is open.
        if (economyState === 'STOCKPILING' && !isCritical) {
            // Keep existing upgraders only. Do not spawn new ones.
            requiredWork = 0;
            minCount = Math.min(upCensus.count, intel.availableControllerSpaces);
            maxCount = minCount;
        }

        debug('mission.upgrade', `[Upgrade] ${room.name} count=${upCensus.count} workParts=${upCensus.workParts}/${desiredWork} ` +
            `requiredWork=${requiredWork} min=${minCount} max=${maxCount} ` +
            `spaces=${intel.availableControllerSpaces} state=${economyState}`);

        missions.push({
            name: upName,
            type: 'upgrade',
            archetype: 'worker',
            targetId: intel.controller.id,
            data: { sourceIds: intel.allEnergySources.map(s => s.id) },
            pos: intel.controller.pos,
            requirements: {
                archetype: 'worker',
                requiredWork: requiredWork,
                minCount: minCount,
                maxCount: maxCount,
                spawn: spawnAllowed,
                spawnFromFleet: true
            },
            priority: upgradePriority
        });
    }
};
