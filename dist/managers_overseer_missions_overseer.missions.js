const managerSpawner = require('managers_spawner_manager.room.economy.spawner');

const missionModules = {
    tower: require('managers_overseer_missions_mission.tower'),
    scout: require('managers_overseer_missions_mission.scout'),
    remoteBuild: require('managers_overseer_missions_mission.remote.build'),
    remoteHarvest: require('managers_overseer_missions_mission.remote.harvest'),
    remoteHaul: require('managers_overseer_missions_mission.remote.haul'),
    remoteReserve: require('managers_overseer_missions_mission.remote.reserve'),
    harvest: require('managers_overseer_missions_mission.harvest'),
    mineral: require('managers_overseer_missions_mission.mineral'),
    logistics: require('managers_overseer_missions_mission.logistics'),
    upgrade: require('managers_overseer_missions_mission.upgrade'),
    build: require('managers_overseer_missions_mission.build'),
    repair: require('managers_overseer_missions_mission.repair'),
    worker: require('managers_overseer_missions_mission.worker'),
    decongest: require('managers_overseer_missions_mission.decongest'),
    dismantle: require('managers_overseer_missions_mission.dismantle')
};

const overseerMissions = {
    generate: function(room, intel, state, economyState, censusCreeps) {
        const missions = [];
        let budget = intel.energyCapacityAvailable;
        if (state === 'EMERGENCY') budget = Math.max(intel.energyAvailable, 300);

        const allCensusCreeps = Array.isArray(censusCreeps) ? censusCreeps : intel.myCreeps;
        const creepsByMission = allCensusCreeps.reduce((acc, c) => {
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

        const economyFlow = (room.memory.overseer && room.memory.overseer.economyFlow) || null;
        const context = { state, economyState, budget, getMissionCensus, efficientSources, economyFlow };

        // Run all mission generators
        missionModules.tower.generate(room, intel, context, missions);
        missionModules.scout.generate(room, intel, context, missions);
        missionModules.remoteBuild.generate(room, intel, context, missions);
        missionModules.remoteHarvest.generate(room, intel, context, missions);
        missionModules.remoteHaul.generate(room, intel, context, missions);
        missionModules.remoteReserve.generate(room, intel, context, missions);
        missionModules.harvest.generate(room, intel, context, missions);
        missionModules.mineral.generate(room, intel, context, missions);
        missionModules.logistics.generate(room, intel, context, missions);
        missionModules.repair.generate(room, intel, context, missions);
        missionModules.upgrade.generate(room, intel, context, missions);
        missionModules.build.generate(room, intel, context, missions);
        missionModules.worker.generate(room, intel, context, missions);
        missionModules.decongest.generate(room, intel, context, missions);
        missionModules.dismantle.generate(room, intel, context, missions);

        return missions;
    }
};

module.exports = overseerMissions;
