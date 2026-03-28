const { profRequire } = require('utils_profRequire');
const missionBoard = profRequire('managers_overseer_missions_board_missionBoard', 'missions.board');

const overseerMissions = {
    generate: function(room, intel, censusCreeps, policyContext) {
        const policy = policyContext && policyContext.policy ? policyContext.policy : null;
        const roomState = policy && policy.state ? policy.state : 'GROW';
        let budget = intel.energyCapacityAvailable;
        if (roomState === 'CRITICAL' || roomState === 'RECOVER') {
            budget = Math.max(intel.energyAvailable, 300);
        }

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
        const context = {
            roomState,
            budget,
            getMissionCensus,
            efficientSources,
            economyFlow,
            condition: policyContext && policyContext.condition ? policyContext.condition : null,
            policy
        };

        // Run persistent mission board updates/reconciliation first.
        missionBoard.runRoom(room, { intel, context });
        const legacyContracts = missionBoard.listLiveByRoom(room.name).filter(m => m && m.type === 'contract');
        for (let i = 0; i < legacyContracts.length; i++) {
            missionBoard.markCancelled(legacyContracts[i].id, 'legacy_contract_removed');
        }

        // Bridge board missions into mission contracts consumed by task assignment.
        // Fetch through the room-scoped per-tick cache instead of rebuilding the same filtered list repeatedly.
        const orderedTypes = [
            'tower',
            'remoteBuild',
            'simpleHarvest',
            'harvest',
            'build',
            'repair',
            'fortify',
            'upgrade',
            'logisticsSimpleCore',
            'logisticsSimpleMining',
            'logisticsCoreV2',
            'logisticsMiningV2',
            'remoteHarvest',
            'remoteReserve',
            'remoteHaul',
            'scout',
            'mineral',
            'userRemoteMove2Flag',
            'userRemoteReserve',
            'userRemoteClaim',
            'userDismantle'
        ];
        const contracts = [];
        for (let i = 0; i < orderedTypes.length; i++) {
            const batch = missionBoard.getMissionContractsForRoom(room.name, orderedTypes[i]);
            if (!batch || batch.length <= 0) continue;
            for (let j = 0; j < batch.length; j++) contracts.push(batch[j]);
        }
        return contracts;
    }
};

module.exports = overseerMissions;
