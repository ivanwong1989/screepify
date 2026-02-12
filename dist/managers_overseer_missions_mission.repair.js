const managerSpawner = require('managers_spawner_manager.room.economy.spawner');

module.exports = {
    generate: function(room, intel, context, missions) {
        const { state, budget } = context;
        if (state === 'EMERGENCY') return;

        const REPAIR_SCAN_INTERVAL = 7; // ticks
        const CRITICAL_WALL_HITS = 5000;
        const CRITICAL_GENERAL_RATIO = 0.2;
        const CRITICAL_DECAYABLE_RATIO = 0.1;

        if (!room.memory.overseer) room.memory.overseer = {};
        if (!room.memory.overseer.repairCache) {
            room.memory.overseer.repairCache = { lastScan: 0, targets: [], critical: false };
        }
        const repairCache = room.memory.overseer.repairCache;
        const now = Game.time;
        const hostilesPresent = intel.hostiles && intel.hostiles.length > 0;
        const combatState = room.memory.admiral && room.memory.admiral.state;
        const siegeMode = combatState === 'SIEGE';

        const isCritical = (s) => {
            if (!s || !s.hitsMax) return false;
            if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
                return s.hits < CRITICAL_WALL_HITS;
            }
            if (s.structureType === STRUCTURE_ROAD || s.structureType === STRUCTURE_CONTAINER) {
                return s.hits < (s.hitsMax * CRITICAL_DECAYABLE_RATIO);
            }
            return s.hits < (s.hitsMax * CRITICAL_GENERAL_RATIO);
        };

        const forceScan = hostilesPresent || siegeMode || repairCache.critical;
        const shouldScan = forceScan || !repairCache.lastScan || (now - repairCache.lastScan) >= REPAIR_SCAN_INTERVAL;

        let repairTargets = [];
        let criticalFound = false;

        if (shouldScan) {
            const allStructures = [].concat(...Object.values(intel.structures));
        
            const decayables = allStructures.filter(s => 
                (s.structureType === STRUCTURE_ROAD || s.structureType === STRUCTURE_CONTAINER) && s.hits < s.hitsMax
            );
            const others = allStructures.filter(s => 
                s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_CONTAINER &&
                s.structureType !== STRUCTURE_WALL && s.structureType !== STRUCTURE_RAMPART && s.hits < s.hitsMax
            );
            const forts = allStructures.filter(s => 
                (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) && s.hits < 50000
            );

            repairTargets.push(...decayables, ...others, ...forts);
            criticalFound = repairTargets.some(isCritical);

            repairCache.targets = repairTargets.map(s => s.id);
            repairCache.lastScan = now;
            repairCache.critical = criticalFound;
        } else {
            const cachedTargets = repairCache.targets || [];
            repairTargets = cachedTargets
                .map(id => Game.getObjectById(id))
                .filter(s => s && s.hits < s.hitsMax);
            criticalFound = repairTargets.some(isCritical);

            repairCache.targets = repairTargets.map(s => s.id);
            repairCache.critical = criticalFound;
        }

        if (repairTargets.length === 0) return;

        const repairStats = managerSpawner.checkBody('worker', budget);
        let repairWorkTarget = repairTargets.length > 10 ? 10 : 5;
        const workPerCreep = repairStats.work || 1;
        const desiredCount = Math.ceil(repairWorkTarget / workPerCreep);

        const getRepairGroup = (s) => {
            if (s.structureType === STRUCTURE_ROAD || s.structureType === STRUCTURE_CONTAINER) return 0;
            if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) return 2;
            return 1;
        };

        const sortedTargets = [...repairTargets].sort((a, b) => {
            const groupDiff = getRepairGroup(a) - getRepairGroup(b);
            if (groupDiff !== 0) return groupDiff;
            const aRatio = a.hitsMax > 0 ? (a.hits / a.hitsMax) : 1;
            const bRatio = b.hitsMax > 0 ? (b.hits / b.hitsMax) : 1;
            return aRatio - bRatio;
        });

        const targetCount = Math.min(desiredCount, sortedTargets.length);
        if (targetCount === 0) return;

        debug('mission.repair', `[Repair] ${room.name} targets=${targetCount}/${repairTargets.length} ` +
            `workPerCreep=${workPerCreep} desired=${desiredCount} critical=${criticalFound}`);

        const selectedTargets = sortedTargets.slice(0, targetCount);
        selectedTargets.forEach(target => {
            missions.push({
                name: `repair:${target.id}`,
                type: 'repair',
                archetype: 'worker',
                targetId: target.id,
                data: { sourceIds: intel.allEnergySources.map(s => s.id) },
                requirements: {
                    archetype: 'worker',
                    count: 1,
                    spawnFromFleet: true
                },
                priority: isCritical(target) ? 85 : 65
            });
        });
    }
};
