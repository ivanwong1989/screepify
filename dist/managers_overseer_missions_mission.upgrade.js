const managerSpawner = require('managers_spawner_manager.room.economy.spawner');
const resolveUpgradeTarget = require('task_resolve_resolveUpgradeTarget');

module.exports = {
    generate: function(room, intel, context, missions) {
        const { state, economyState, budget, getMissionCensus, economyFlow } = context;
        if (!intel.controller || !intel.controller.my || state === 'EMERGENCY') return;

        const ticksToDowngrade = intel.controller.ticksToDowngrade || 0;
        const CRITICAL_DOWNGRADE_TICKS = 5000;
        const isCritical = ticksToDowngrade < CRITICAL_DOWNGRADE_TICKS;

        const flowAvg = economyFlow && Number.isFinite(economyFlow.avg) ? economyFlow.avg : 0;
        const STOCKPILE_PERIOD = 50;
        const STOCKPILE_WINDOW = 40; // 20% uptime while stockpiling (if flow is non-negative)
        const allowStockpileWindow = (Game.time % STOCKPILE_PERIOD) < STOCKPILE_WINDOW;
        const allowStockpileUpgrade = isCritical || (flowAvg >= 0 && allowStockpileWindow);

        if (economyState === 'STOCKPILING' && !allowStockpileUpgrade) return;

        let upgradePriority = 50;
        let desiredWork = 5;
        let spawnAllowed = true;

        if (economyState === 'STOCKPILING') {
            desiredWork = 1;
            upgradePriority = 10;
            spawnAllowed = isCritical;
            if (isCritical) upgradePriority = 100;
        } else if (intel.energyAvailable >= intel.energyCapacityAvailable * 0.95) {
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
        const workPerCreep = upStats.work || 1;
        const desiredCount = Math.min(Math.ceil(desiredWork / workPerCreep), intel.availableControllerSpaces);

        let upCount = 0;
        if (upCensus.workParts >= desiredWork) {
            upCount = Math.max(1, desiredCount);
        } else {
            const upDeficit = Math.max(0, desiredWork - upCensus.workParts);
            const upNeeded = Math.ceil(upDeficit / workPerCreep);
            upCount = Math.min(upCensus.count + upNeeded, intel.availableControllerSpaces);
            if (desiredWork > 0 && upCount < 1) upCount = 1;
        }

        if (intel.constructionSites.length > 0) {
            upCount = Math.max(1, desiredCount);
        }
        if (economyState === 'STOCKPILING' && !isCritical) {
            upCount = Math.min(upCount, 1);
        }

        debug('mission.upgrade', `[Upgrade] ${room.name} count=${upCensus.count} workParts=${upCensus.workParts}/${desiredWork} ` +
            `workPerCreep=${workPerCreep} desired=${desiredCount} req=${upCount} ` +
            `spaces=${intel.availableControllerSpaces} state=${economyState}`);

        const targetId = resolveUpgradeTarget(room, intel);
        if (!targetId) return;

        missions.push({
            name: upName,
            type: 'upgrade',
            archetype: 'worker',
            targetId: targetId,
            data: { sourceIds: intel.allEnergySources.map(s => s.id) },
            pos: intel.controller.pos,
            requirements: { archetype: 'worker', count: upCount, spawn: spawnAllowed, spawnFromFleet: true },
            priority: upgradePriority
        });
    }
};
