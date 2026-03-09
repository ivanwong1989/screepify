// managers_overseer_missions_mission.idleUpgrade.js
module.exports = {
    generate: function(room, intel, context, missions) {
        const { opState } = context;
        if (!intel.controller || !intel.controller.my || opState === 'EMERGENCY') return;

        const raw = intel.availableControllerSpaces || 1;
        // cap so intel bugs / huge open area doesn't cause silly quotas
        const maxSpaces = Math.min(12, Math.max(1, raw));

        missions.push({
            name: 'idle:upgrade',
            type: 'upgrade',
            archetype: 'worker',
            targetId: intel.controller.id,
            data: { sourceIds: (intel.allEnergySources || []).map(s => s.id) },
            pos: intel.controller.pos,

            // Never spawn for idle upgrade.
            requirements: {
                archetype: 'worker',
                minCount: 0,
                maxCount: maxSpaces,
                spawn: false,
                spawnFromFleet: false
            },

            // Must be lower than everything else.
            priority: -100
        });
    }
};
