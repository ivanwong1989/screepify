const managerSpawner = require('managers_spawner_manager.room.economy.spawner');
const overseerOpportunisticRepair = require('managers_overseer_intel_overseer.opportunistic.repair');

module.exports = {
    generate: function(room, intel, context, missions) {
        const { opState, budget, getMissionCensus } = context;
        if (opState === 'EMERGENCY') return;

        const CRITICAL_WALL_HITS = 5000;

        const rcl = room.controller ? room.controller.level : 0;
        const FORTIFY_SETTINGS = {
            0: { start: 0, target: 0 },
            1: { start: 0, target: 0 },
            2: { start: 10000, target: 20000 },
            3: { start: 20000, target: 150000 },
            4: { start: 150000, target: 300000 },
            5: { start: 300000, target: 500000 },
            6: { start: 500000, target: 1300000 },
            7: { start: 2000000, target: 3000000 },
            8: { start: 3500000, target: 5000000 }
        };
        const settings = FORTIFY_SETTINGS[rcl] || FORTIFY_SETTINGS[0];
        const FORTIFY_START_HITS = settings.start;
        const FORTIFY_TARGET_HITS = settings.target;

        // Hacky way to get fortify values to memory for downstream usage. might need to move to policy layer later
        if (!room.memory.overseer) room.memory.overseer = {};

        room.memory.overseer.fortifyPolicy = {
        rcl,
        start: FORTIFY_START_HITS,
        target: FORTIFY_TARGET_HITS,
        updated: Game.time
        };

        const REPAIR_MIN_RATIO = 0.9;
        const CRITICAL_GENERAL_RATIO = 0.8;
        const CRITICAL_DECAYABLE_RATIO = 0.7;

        const hostilesPresent = intel.hostiles && intel.hostiles.length > 0;
        const combatState = room.memory.admiral && room.memory.admiral.state;
        const siegeMode = combatState === 'SIEGE';
        // Scanner is the source of truth for IDs; mission only refreshes objects.
        const scanStore = overseerOpportunisticRepair.getRoomScan(room.name);
        if (!scanStore) return;
        const previousFortifyIds = new Set(Array.isArray(scanStore.fortifyIds) ? scanStore.fortifyIds : []);

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

        const needsRepair = (s) => {
            if (!s || !s.hitsMax) return false;
            if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) return false;
            return s.hits < (s.hitsMax * REPAIR_MIN_RATIO);
        };

        const getActiveForts = (structures) => {
            return structures.filter(s => {
                if (s.structureType !== STRUCTURE_WALL && s.structureType !== STRUCTURE_RAMPART) return false;
                if (s.hits < FORTIFY_START_HITS) return true;
                return previousFortifyIds.has(s.id) && s.hits < FORTIFY_TARGET_HITS;
            });
        };

        let repairTargets = [];
        let fortifyTargets = [];
        let criticalFound = false;
        // Consume scanner output (already classified in the intel layer),
        // then re-validate object liveness/state before issuing missions.
        const cachedTargets = Array.isArray(scanStore.targetIds) ? scanStore.targetIds : [];
        const refreshedTargets = cachedTargets
            .map(id => Game.getObjectById(id))
            .filter(s => s && (needsRepair(s) || isCritical(s) || getActiveForts([s]).length > 0));

        const decayables = refreshedTargets.filter(s =>
            (s.structureType === STRUCTURE_ROAD || s.structureType === STRUCTURE_CONTAINER) && needsRepair(s)
        );
        const others = refreshedTargets.filter(s =>
            s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_CONTAINER &&
            s.structureType !== STRUCTURE_WALL && s.structureType !== STRUCTURE_RAMPART && needsRepair(s)
        );
        const activeForts = getActiveForts(refreshedTargets);
        const criticalForts = activeForts.filter(isCritical);
        const nonCriticalForts = activeForts.filter(s => !isCritical(s));

        repairTargets = decayables.concat(others, criticalForts);
        fortifyTargets = nonCriticalForts;
        criticalFound = repairTargets.some(isCritical);

        // Keep heap payload fresh after liveness filtering, so next tick can stay cheap.
        scanStore.repairIds = repairTargets.map(s => s.id);
        scanStore.fortifyIds = activeForts.map(s => s.id);
        scanStore.targetIds = repairTargets.concat(fortifyTargets).map(s => s.id);
        scanStore.critical = criticalFound;

        if (repairTargets.length === 0 && fortifyTargets.length === 0) return;

        let workPerCreep = 1;
        let desiredCount = 0;
        if (repairTargets.length > 0) {
            const repairStats = managerSpawner.checkBody('worker', budget);

            // Baseline (existing behavior): small steady repair throughput by RCL
            const baseWork = 5 + Math.max(0, rcl - 3) * 2;

            // Backlog scaling: increase target WORK as queue grows.
            const BACKLOG_PER = 12;
            const BACKLOG_WORK_PER_CHUNK = 1;
            const backlogWork = Math.floor(repairTargets.length / BACKLOG_PER) * BACKLOG_WORK_PER_CHUNK;

            // Urgency boosts (optional but nice):
            const criticalBoost = criticalFound ? 10 : 0;              // slam harder when critical exists
            const siegeBoost = (hostilesPresent || siegeMode) ? 6 : 0; // extra repairs during active threat

            // Hard cap so repair pressure cannot consume the entire economy.
            const MAX_REPAIR_WORK_TARGET = 50;

            const repairWorkTarget = Math.min(
                MAX_REPAIR_WORK_TARGET,
                baseWork + backlogWork + criticalBoost + siegeBoost
            );

            workPerCreep = repairStats.work || 1;
            desiredCount = Math.ceil(repairWorkTarget / workPerCreep);
        }

        const getRepairGroup = (s) => {
            if (s.structureType === STRUCTURE_ROAD || s.structureType === STRUCTURE_CONTAINER) return 0;
            if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) return 2;
            return 1;
        };

        const getMissionCount = (name) => {
            if (typeof getMissionCensus !== 'function') return 0;
            const census = getMissionCensus(name);
            if (!census || !Number.isFinite(census.count)) return 0;
            return census.count;
        };

        const sortedTargets = [...repairTargets].sort((a, b) => {
            const groupDiff = getRepairGroup(a) - getRepairGroup(b);
            if (groupDiff !== 0) return groupDiff;
            const aRatio = a.hitsMax > 0 ? (a.hits / a.hitsMax) : 1;
            const bRatio = b.hitsMax > 0 ? (b.hits / b.hitsMax) : 1;
            return aRatio - bRatio;
        });

        const stickyRepairTargets = [];
        const stickyRepairIds = new Set();
        // Keep existing repair missions sticky to reduce target thrash/repathing.
        sortedTargets.forEach(target => {
            if (getMissionCount(`repair:${target.id}`) > 0) {
                stickyRepairTargets.push(target);
                stickyRepairIds.add(target.id);
            }
        });

        const targetCount = Math.min(
            sortedTargets.length,
            Math.max(desiredCount, stickyRepairTargets.length)
        );
        const selectedTargets = stickyRepairTargets.concat(
            sortedTargets
                .filter(target => !stickyRepairIds.has(target.id))
                .slice(0, Math.max(0, targetCount - stickyRepairTargets.length))
        );

        if (selectedTargets.length > 0) {
            debug('mission.repair', `[Repair] ${room.name} targets=${targetCount}/${repairTargets.length} ` +
                `workPerCreep=${workPerCreep} desired=${desiredCount} critical=${criticalFound}`);
        }

        if (selectedTargets.length > 0) {
            selectedTargets.forEach(target => {
                missions.push({
                    name: `repair:${target.id}`,
                    type: 'repair',
                    archetype: 'worker',
                    targetId: target.id,
                    data: { sourceIds: intel.allEnergySources.map(s => s.id), allowPartial: true },
                    requirements: {
                        archetype: 'worker',
                        count: 1,
                        spawn: true,
                        spawnFromFleet: true
                    },
                    priority: isCritical(target) ? 85 : 65
                });
            });
        }

        if (fortifyTargets.length > 0) {
            const FORTIFY_TARGET_CAP = 3;

            // Hard caps (safety)
            const FORTIFY_MAX_COUNT_PER_TARGET = 4;
            const MAX_FORTIFY_WORK_TARGET = 20; // total desired WORK across all fortify missions (rough)

            // Don't spawn fortifiers while repairs are still huge
            const REPAIR_BACKLOG_BLOCK_SPAWN = 15;

            // Economy signals (source of truth: intel)
            const overseerMem = room.memory.overseer || {}; // fallback only
            const economyState = (intel && intel.economyState)
                ? intel.economyState
                : (overseerMem.economyState || 'STOCKPILING'); // 'STOCKPILING' | 'UPGRADING'

            // Threat / urgency
            const direFortify = siegeMode || hostilesPresent;
            const normalFortifyAllowed = economyState === 'UPGRADING';
            // Under normal conditions, fortify is controlled only by economy state.
            // In threat/siege, allow fortify regardless of economy state.
            if (!direFortify && !normalFortifyAllowed) {
                debug(
                    'mission.repair',
                    `[Fortify] ${room.name} skipped state=${economyState} dire=${direFortify} repairBacklog=${repairTargets.length}`
                );
                return;
            }

            // We can still publish fortify work for existing creeps (spawn=false).
            const stats = managerSpawner.checkBody('worker', budget);
            const fortifyWorkPerCreep = stats.work || 1;
            const scaledFortifyWorkTarget = direFortify
                ? MAX_FORTIFY_WORK_TARGET
                : Math.floor(MAX_FORTIFY_WORK_TARGET * 0.6);
            const desiredFortifyWorkers = Math.max(1, Math.ceil(scaledFortifyWorkTarget / fortifyWorkPerCreep));

            // Spawn rules:
            // - Always block spawn if repair backlog is big.
            // - Otherwise allow if we're in threat/siege OR economy is in UPGRADING.
            const allowFortifySpawn = (
                (repairTargets.length <= REPAIR_BACKLOG_BLOCK_SPAWN) &&
                (direFortify || normalFortifyAllowed) &&
                desiredFortifyWorkers > 0
            );

            const sortedForts = [...fortifyTargets].sort((a, b) => {
                const aRatio = a.hitsMax > 0 ? (a.hits / a.hitsMax) : 1;
                const bRatio = b.hitsMax > 0 ? (b.hits / b.hitsMax) : 1;
                return aRatio - bRatio;
            });

            const stickyFortTargets = [];
            const stickyFortIds = new Set();
            // Sticky fortify targets reduce switching between walls/ramparts.
            sortedForts.forEach(target => {
                if (getMissionCount(`fortify:${target.id}`) > 0) {
                    stickyFortTargets.push(target);
                    stickyFortIds.add(target.id);
                }
            });

            const fortifyCount = Math.min(
                sortedForts.length,
                Math.max(FORTIFY_TARGET_CAP, stickyFortTargets.length)
            );

            const selectedForts = stickyFortTargets.concat(
                sortedForts
                    .filter(target => !stickyFortIds.has(target.id))
                    .slice(0, Math.max(0, fortifyCount - stickyFortTargets.length))
            );

            // Scale workers per target based on desired total workers and number of selected targets
            const fortifyCountPerTarget = Math.max(
                1,
                Math.min(
                    FORTIFY_MAX_COUNT_PER_TARGET,
                    selectedForts.length > 0 ? Math.ceil(desiredFortifyWorkers / selectedForts.length) : 1
                )
            );

            debug(
                'mission.repair',
                `[Fortify] ${room.name} state=${economyState} ` +
                `targets=${selectedForts.length}/${fortifyTargets.length} countPerTarget=${fortifyCountPerTarget} ` +
                `spawn=${allowFortifySpawn} dire=${direFortify} repairBacklog=${repairTargets.length}`
            );

            selectedForts.forEach(target => {
                missions.push({
                    name: `fortify:${target.id}`,
                    type: 'repair',
                    archetype: 'worker',
                    targetId: target.id,
                    data: { sourceIds: intel.allEnergySources.map(s => s.id), fortify: true, allowPartial: true },
                    requirements: {
                        archetype: 'worker',
                        count: fortifyCountPerTarget,
                        spawnFromFleet: true,
                        spawn: allowFortifySpawn
                    },
                    priority: allowFortifySpawn ? 55 : 35
                });
            });
        }
    }
};
