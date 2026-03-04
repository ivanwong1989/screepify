const managerSpawner = require('managers_spawner_manager.room.economy.spawner');

const missionModules = {
    tower: require('managers_overseer_missions_mission.tower'),
    scout: require('managers_overseer_missions_mission.scout'),
    remoteBuild: require('managers_overseer_missions_mission.remote.build'),
    remoteRepair: require('managers_overseer_missions_mission.remote.repair'),
    remoteHarvest: require('managers_overseer_missions_mission.remote.harvest'),
    remoteHaul: require('managers_overseer_missions_mission.remote.haul'),
    userRemoteReserve: require('managers_overseer_missions_mission.user.remote.reserve'),
    userRemoteClaim: require('managers_overseer_missions_mission.user.remote.claim'),
    userRemoteMove2Flag: require('managers_overseer_missions_mission.user.remote.move2flag'),
    harvest: require('managers_overseer_missions_mission.harvest'),
    mineral: require('managers_overseer_missions_mission.mineral'),
    fleetLogistic: require('managers_overseer_missions_mission.fleet_logistic'),
    logistics: require('managers_overseer_missions_mission.logistics'),
    labs: require('managers_overseer_missions_mission.labs'),
    upgrade: require('managers_overseer_missions_mission.upgrade'),
    build: require('managers_overseer_missions_mission.build'),
    repair: require('managers_overseer_missions_mission.repair'),
    decongest: require('managers_overseer_missions_mission.decongest'),
    userDismantle: require('managers_overseer_missions_mission.user.dismantle'),
    userTransfer: require('managers_overseer_missions_mission.user.transfer')
};

const overseerMissions = {
    generate: function(room, intel, opState, economyState, censusCreeps) {
        const missions = [];
        let budget = intel.energyCapacityAvailable;
        if (opState === 'EMERGENCY') budget = Math.max(intel.energyAvailable, 300);

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

        // baseline rule (your existing intent, but keep as-is)
        intel.sources.forEach(s => {
            const needed = Math.ceil(5 / (potentialHarvester.work || 1));
            const viable = needed <= s.availableSpaces;

            const isEfficient =
                viable &&
                (budget > 300 || s.hasContainer || intel.haulerCapacity > 0);

            if (isEfficient) efficientSources.add(s.id);
        });

        // Bootstrap: if nothing qualifies yet (common at RCL1), allow 1 source anyway.
        // This breaks the hauler chicken-and-egg without making everything "efficient".
        if (efficientSources.size === 0) {
            // Pick the most viable source (most spaces). If tie, just take first.
            let best = null;
            let bestSpaces = -1;

            intel.sources.forEach(s => {
                const needed = Math.ceil(5 / (potentialHarvester.work || 1));
                const viable = needed <= s.availableSpaces;
                if (!viable) return;

                const spaces = s.availableSpaces || 0;
                if (spaces > bestSpaces) {
                    best = s;
                    bestSpaces = spaces;
                }
            });

            if (best) efficientSources.add(best.id);
        }

        const economyFlow = (room.memory.overseer && room.memory.overseer.economyFlow) || null;
        const context = { opState, economyState, budget, getMissionCensus, efficientSources, economyFlow };

        // Run all mission generators
        missionModules.tower.generate(room, intel, context, missions);
        missionModules.scout.generate(room, intel, context, missions);
        missionModules.remoteBuild.generate(room, intel, context, missions);
        //missionModules.remoteRepair.generate(room, intel, context, missions);
        missionModules.remoteHarvest.generate(room, intel, context, missions);
        missionModules.remoteHaul.generate(room, intel, context, missions);
        missionModules.userRemoteReserve.generate(room, intel, context, missions);
        missionModules.userRemoteClaim.generate(room, intel, context, missions);
        missionModules.userRemoteMove2Flag.generate(room, intel, context, missions);
        missionModules.harvest.generate(room, intel, context, missions);
        missionModules.mineral.generate(room, intel, context, missions);
        missionModules.fleetLogistic.generate(room, intel, context, missions);
        missionModules.logistics.generate(room, intel, context, missions);
        missionModules.labs.generate(room, intel, context, missions);
        missionModules.repair.generate(room, intel, context, missions);
        missionModules.upgrade.generate(room, intel, context, missions);
        missionModules.build.generate(room, intel, context, missions);
        missionModules.decongest.generate(room, intel, context, missions);
        missionModules.userDismantle.generate(room, intel, context, missions);
        missionModules.userTransfer.generate(room, intel, context, missions);

        return missions;
    }
};

module.exports = overseerMissions;
