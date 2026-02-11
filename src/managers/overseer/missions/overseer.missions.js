const managerSpawner = require('managers_spawner_manager.room.economy.spawner');

const missionModules = {
    tower: require('managers_overseer_missions_mission.tower'),
    harvest: require('managers_overseer_missions_mission.harvest'),
    logistics: require('managers_overseer_missions_mission.logistics'),
    upgrade: require('managers_overseer_missions_mission.upgrade'),
    build: require('managers_overseer_missions_mission.build'),
    repair: require('managers_overseer_missions_mission.repair'),
    decongest: require('managers_overseer_missions_mission.decongest')
};

const overseerMissions = {
    generate: function(room, intel, state, economyState) {
        const missions = [];
        let budget = intel.energyCapacityAvailable;
        if (state === 'EMERGENCY') budget = Math.max(intel.energyAvailable, 300);

        const creepsByMission = intel.myCreeps.reduce((acc, c) => {
            const key = c.memory.missionName;
            acc[key] = acc[key] || [];
            acc[key].push(c);
            return acc;
        }, {});

        const getMissionCensus = (name) => {
            const creeps = creepsByMission[name] || [];
            return {
                count: creeps.length,
                workParts: creeps.reduce((sum, c) => sum + c.getActiveBodyparts(WORK), 0),
                carryParts: creeps.reduce((sum, c) => sum + c.getActiveBodyparts(CARRY), 0)
            };
        };

        // Pre-calculate efficiency for harvest/logistics
        const efficientSources = new Set();
        const potentialHarvester = managerSpawner.checkBody('miner', budget);
        intel.sources.forEach(s => {
            const needed = Math.ceil(5 / (potentialHarvester.work || 1));
            if (needed <= s.availableSpaces && (budget > 300 || s.hasContainer || intel.haulerCapacity > 0)) {
                efficientSources.add(s.id);
            }
        });

        const context = { state, economyState, budget, getMissionCensus, efficientSources };

        // Run all mission generators
        missionModules.tower.generate(room, intel, context, missions);
        missionModules.harvest.generate(room, intel, context, missions);
        missionModules.logistics.generate(room, intel, context, missions);
        missionModules.repair.generate(room, intel, context, missions);
        missionModules.upgrade.generate(room, intel, context, missions);
        missionModules.build.generate(room, intel, context, missions);
        missionModules.decongest.generate(room, intel, context, missions);

        return missions;
    }
};

module.exports = overseerMissions;
