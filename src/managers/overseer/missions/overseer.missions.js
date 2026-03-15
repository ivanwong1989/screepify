const missionBoard = require('managers_overseer_missions_board_missionBoard');

const overseerMissions = {
    generate: function(room, intel, opState, economyState, censusCreeps) {
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
        const estimateMinerWork = (energyBudget) => {
            const safeBudget = Math.max(200, energyBudget || 0);
            return Math.max(1, Math.min(7, 1 + Math.floor((safeBudget - 200) / 100)));
        };
        const potentialMinerWork = estimateMinerWork(budget);

        // baseline rule (your existing intent, but keep as-is)
        intel.sources.forEach(s => {
            const needed = Math.ceil(5 / potentialMinerWork);
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
                const needed = Math.ceil(5 / potentialMinerWork);
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

        // Run persistent mission board updates/detectors first.
        missionBoard.runRoom(room, { intel, context });

        // Bridge board missions into mission contracts consumed by task assignment.
        const boardHarvestMissions = missionBoard.getMissionContractsForRoom(room.name, 'harvest');
        const boardBuildMissions = missionBoard.getMissionContractsForRoom(room.name, 'build');
        const boardRepairMissions = missionBoard.getMissionContractsForRoom(room.name, 'repair');
        const boardUpgradeMissions = missionBoard.getMissionContractsForRoom(room.name, 'upgrade');
        const boardLogisticsLane = missionBoard.getMissionContractsForRoom(room.name, 'logisticsLane');
        const boardLogisticsJob = missionBoard.getMissionContractsForRoom(room.name, 'logisticsJob');
        const boardLogisticsFleet = missionBoard.getMissionContractsForRoom(room.name, 'logisticsFleet');
        const boardRemoteHarvest = missionBoard.getMissionContractsForRoom(room.name, 'remoteHarvest');
        const boardRemoteHaul = missionBoard.getMissionContractsForRoom(room.name, 'remoteHaul');
        const boardScout = missionBoard.getMissionContractsForRoom(room.name, 'scout');
        const boardMineral = missionBoard.getMissionContractsForRoom(room.name, 'mineral');
        const boardDecongest = missionBoard.getMissionContractsForRoom(room.name, 'decongest');
        const boardContractMissions = missionBoard.getMissionContractsForRoom(room.name, 'contract');
        const boardTowerManaged = missionBoard.getMissionContractsForRoom(room.name, 'towerManaged');
        const boardLabsManaged = missionBoard.getMissionContractsForRoom(room.name, 'labsManaged');
        const boardRemoteBuildManaged = missionBoard.getMissionContractsForRoom(room.name, 'remoteBuildManaged');
        const boardUserTransfer = missionBoard.getMissionContractsForRoom(room.name, 'userTransfer');
        const boardUserMove2Flag = missionBoard.getMissionContractsForRoom(room.name, 'userRemoteMove2Flag');
        const boardUserReserve = missionBoard.getMissionContractsForRoom(room.name, 'userRemoteReserve');
        const boardUserClaim = missionBoard.getMissionContractsForRoom(room.name, 'userRemoteClaim');
        const boardUserDismantle = missionBoard.getMissionContractsForRoom(room.name, 'userDismantle');

        return (boardContractMissions || [])
            .concat(boardTowerManaged || [])
            .concat(boardLabsManaged || [])
            .concat(boardRemoteBuildManaged || [])
            .concat(boardHarvestMissions || [])
            .concat(boardBuildMissions || [])
            .concat(boardRepairMissions || [])
            .concat(boardUpgradeMissions || [])
            .concat(boardLogisticsLane || [])
            .concat(boardLogisticsJob || [])
            .concat(boardLogisticsFleet || [])
            .concat(boardRemoteHarvest || [])
            .concat(boardRemoteHaul || [])
            .concat(boardScout || [])
            .concat(boardMineral || [])
            .concat(boardDecongest || [])
            .concat(boardUserTransfer || [])
            .concat(boardUserMove2Flag || [])
            .concat(boardUserReserve || [])
            .concat(boardUserClaim || [])
            .concat(boardUserDismantle || []);
    }
};

module.exports = overseerMissions;

