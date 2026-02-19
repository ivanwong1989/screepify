'use strict';

const managerSpawner = require('managers_spawner_manager.room.economy.spawner');

module.exports = function resolveRepairTarget(room, intel, context) {
    const { budget, getMissionCensus } = context || {};
    const REPAIR_SCAN_INTERVAL = 7; // ticks
    const CRITICAL_WALL_HITS = 5000;

    const rcl = room.controller ? room.controller.level : 0;
    const FORTIFY_SETTINGS = {
        0: { start: 0, target: 0 },
        1: { start: 0, target: 0 },
        2: { start: 10000, target: 20000 },
        3: { start: 20000, target: 150000 },
        4: { start: 150000, target: 300000 },
        5: { start: 300000, target: 500000 },
        6: { start: 500000, target: 800000 },
        7: { start: 800000, target: 1300000 },
        8: { start: 1300000, target: 5000000 }
    };
    const settings = FORTIFY_SETTINGS[rcl] || FORTIFY_SETTINGS[0];
    const FORTIFY_START_HITS = settings.start;
    const FORTIFY_TARGET_HITS = settings.target;

    const REPAIR_MIN_RATIO = 0.9;
    const CRITICAL_GENERAL_RATIO = 0.8;
    const CRITICAL_DECAYABLE_RATIO = 0.7;

    if (!room.memory.overseer) room.memory.overseer = {};
    if (!room.memory.overseer.repairCache) {
        room.memory.overseer.repairCache = { lastScan: 0, targets: [], critical: false, fortifyIds: [] };
    }
    const repairCache = room.memory.overseer.repairCache;
    if (!Array.isArray(repairCache.fortifyIds)) repairCache.fortifyIds = [];
    const now = Game.time;
    const hostilesPresent = intel.hostiles && intel.hostiles.length > 0;
    const combatState = room.memory.admiral && room.memory.admiral.state;
    const siegeMode = combatState === 'SIEGE';
    const previousFortifyIds = new Set(repairCache.fortifyIds);

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

    const forceScan = hostilesPresent || siegeMode || repairCache.critical;
    const shouldScan = forceScan || !repairCache.lastScan || (now - repairCache.lastScan) >= REPAIR_SCAN_INTERVAL;

    let repairTargets = [];
    let fortifyTargets = [];
    let criticalFound = false;

    if (shouldScan) {
        const allStructures = [].concat(...Object.values(intel.structures));
    
        const decayables = allStructures.filter(s => 
            (s.structureType === STRUCTURE_ROAD || s.structureType === STRUCTURE_CONTAINER) && needsRepair(s)
        );
        const others = allStructures.filter(s => 
            s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_CONTAINER &&
            s.structureType !== STRUCTURE_WALL && s.structureType !== STRUCTURE_RAMPART && needsRepair(s)
        );
        const activeForts = getActiveForts(allStructures);
        const criticalForts = activeForts.filter(isCritical);
        const nonCriticalForts = activeForts.filter(s => !isCritical(s));

        repairTargets.push(...decayables, ...others, ...criticalForts);
        fortifyTargets.push(...nonCriticalForts);
        criticalFound = repairTargets.some(isCritical);

        repairCache.targets = repairTargets.concat(fortifyTargets).map(s => s.id);
        repairCache.lastScan = now;
        repairCache.critical = criticalFound;
        repairCache.fortifyIds = activeForts.map(s => s.id);
    } else {
        const cachedTargets = repairCache.targets || [];
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

        repairCache.targets = repairTargets.concat(fortifyTargets).map(s => s.id);
        repairCache.critical = criticalFound;
        repairCache.fortifyIds = activeForts.map(s => s.id);
    }

    if (repairTargets.length === 0 && fortifyTargets.length === 0) return null;

    let workPerCreep = 1;
    let desiredCount = 0;
    if (repairTargets.length > 0) {
        const repairStats = managerSpawner.checkBody('worker', budget);
        let repairWorkTarget = repairTargets.length > 10 ? 10 : 5;
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

    if (fortifyTargets.length > 0) {
        const FORTIFY_TARGET_CAP = 3;
        const sortedForts = [...fortifyTargets].sort((a, b) => {
            const aRatio = a.hitsMax > 0 ? (a.hits / a.hitsMax) : 1;
            const bRatio = b.hitsMax > 0 ? (b.hits / b.hitsMax) : 1;
            return aRatio - bRatio;
        });
        const stickyFortTargets = [];
        const stickyFortIds = new Set();
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

        return {
            criticalFound,
            repairTargets,
            fortifyTargets,
            selectedTargets,
            selectedForts,
            workPerCreep,
            desiredCount,
            targetCount,
            criticalIds: new Set(selectedTargets.filter(isCritical).map(t => t.id))
        };
    }

    return {
        criticalFound,
        repairTargets,
        fortifyTargets,
        selectedTargets,
        selectedForts: [],
        workPerCreep,
        desiredCount,
        targetCount,
        criticalIds: new Set(selectedTargets.filter(isCritical).map(t => t.id))
    };
};
