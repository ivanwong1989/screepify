const resolveRepairTarget = require('task_resolve_resolveRepairTarget');

module.exports = {
    generate: function(room, intel, context, missions) {
        const { state } = context;
        if (state === 'EMERGENCY') return;

        const res = resolveRepairTarget(room, intel, context);
        if (!res) return;

        const {
            selectedTargets,
            selectedForts,
            workPerCreep,
            desiredCount,
            repairTargets,
            criticalFound,
            targetCount,
            criticalIds
        } = res;

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
                    data: { sourceIds: intel.allEnergySources.map(s => s.id) },
                    requirements: {
                        archetype: 'worker',
                        count: 1,
                        spawnFromFleet: true
                    },
                    priority: criticalIds.has(target.id) ? 85 : 65
                });
            });
        }

        if (selectedForts.length > 0) {
            debug('mission.repair', `[Fortify] ${room.name} targets=${selectedForts.length}/${res.fortifyTargets.length}`);

            selectedForts.forEach(target => {
                missions.push({
                    name: `fortify:${target.id}`,
                    type: 'repair',
                    archetype: 'worker',
                    targetId: target.id,
                    data: { sourceIds: intel.allEnergySources.map(s => s.id), fortify: true },
                    requirements: {
                        archetype: 'worker',
                        count: 1,
                        spawnFromFleet: true,
                        spawn: false
                    },
                    priority: 35
                });
            });
        }
    }
};
