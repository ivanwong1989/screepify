function isRemoteContract(entry) {
    const contract = entry && entry.contract ? entry.contract : null;
    const mission = entry && entry.mission ? entry.mission : null;
    const role = contract && contract.role ? String(contract.role) : '';
    const missionType = mission && mission.type ? String(mission.type).toLowerCase() : '';
    const targetRoom = mission && mission.data && mission.data.targetRoom ? mission.data.targetRoom : null;
    const homeRoom = contract && contract.homeRoom ? contract.homeRoom : null;

    if (role.indexOf('remote_') === 0) return true;
    if (missionType.indexOf('remote') !== -1) return true;
    if (targetRoom && homeRoom && targetRoom !== homeRoom) return true;
    return false;
}

function getContractSpawnTier(entry) {
    const contract = entry && entry.contract ? entry.contract : null;
    const role = contract && contract.role ? String(contract.role) : '';
    if (role === 'miner' || role === 'hauler') return 0;
    if (isRemoteContract(entry)) return 2;
    return 1;
}

const spawnPlanner = {
    plan: function(room, contractEntries, fulfillment, options) {
        if (!contractEntries || contractEntries.length === 0) return null;

        const unmet = [];
        for (const entry of contractEntries) {
            const contract = entry && entry.contract;
            if (!contract || !contract.contractId) continue;

            const status = fulfillment && fulfillment[contract.contractId]
                ? fulfillment[contract.contractId]
                : { live: 0, inflight: 0, effective: 0 };
            const desired = Number.isFinite(contract.desired) ? contract.desired : 0;
            const effective = Number.isFinite(status.effective) ? status.effective : 0;
            const deficit = Math.max(0, desired - effective);
            if (deficit <= 0) continue;

            unmet.push({ entry, status, desired, effective, deficit });
        }

        if (unmet.length === 0) {
            debug('spawner', `[SpawnPlanner] ${room.name} no unmet contracts`);
            return null;
        }

        unmet.sort((a, b) => {
            const tierA = getContractSpawnTier(a.entry);
            const tierB = getContractSpawnTier(b.entry);
            if (tierA !== tierB) return tierA - tierB;

            const prioA = Number.isFinite(a.entry.contract.priority) ? a.entry.contract.priority : 0;
            const prioB = Number.isFinite(b.entry.contract.priority) ? b.entry.contract.priority : 0;
            if (prioA !== prioB) return prioB - prioA;

            if (a.deficit !== b.deficit) return b.deficit - a.deficit;

            const idA = String(a.entry.contract.contractId || '');
            const idB = String(b.entry.contract.contractId || '');
            return idA.localeCompare(idB);
        });

        for (const item of unmet) {
            const candidate = this.buildSpawnCandidate(item.entry, room, options);
            if (!candidate) continue;
            candidate.desired = item.desired;
            candidate.fulfilled = item.effective;
            candidate.deficit = item.deficit;
            return candidate;
        }

        return null;
    },

    buildSpawnCandidate: function(entry, room, options) {
        const mission = entry && entry.mission;
        const contract = entry && entry.contract;
        if (!contract) return null;

        const budget = this.computeBudget(room);
        const buildBody = options && options.buildBody;
        const calculateBodyCost = options && options.calculateBodyCost;
        if (!buildBody || !calculateBodyCost) return null;

        const body = buildBody(mission, budget);
        if (!Array.isArray(body) || body.length === 0) return null;
        const cost = calculateBodyCost(body);

        const memory = {
            role: contract.role,
            room: room.name,
            taskState: 'init',
            contractId: contract.contractId,
            bindMode: contract.bindMode,
            bindId: contract.bindId
        };

        if (contract.bindMode !== 'pool' && mission && mission.name) {
            memory.missionName = mission.name;
            if (mission.data) {
                if (mission.data.assaultRole) memory.assaultRole = mission.data.assaultRole;
                if (mission.data.squadKey) memory.assaultSquad = mission.data.squadKey;
                if (mission.data.mode) memory.assaultMode = mission.data.mode;
            }
        }

        if (mission && mission.data && mission.data.targetRoom) {
            memory.targetRoom = mission.data.targetRoom;
        }

        return {
            contractId: contract.contractId,
            missionName: mission && mission.name ? mission.name : null,
            role: contract.role,
            archetype: mission && mission.archetype ? mission.archetype : contract.role,
            priority: Number.isFinite(contract.priority) ? contract.priority : 0,
            bindMode: contract.bindMode,
            bindId: contract.bindId,
            homeRoom: contract.homeRoom || room.name,
            targetRoom: mission && mission.data ? mission.data.targetRoom : null,
            replaceLeadTicks: Number.isFinite(contract.replaceLeadTicks) ? contract.replaceLeadTicks : null,
            body,
            cost,
            memory
        };
    },

    computeBudget: function(room) {
        const opState = room._opState;
        let budget = room.energyCapacityAvailable;

        const cache = global.getRoomCache(room);
        const myCreeps = cache.myCreeps || [];

        const hasMiners = myCreeps.some(c => c.memory.role === 'miner' && !c.spawning);
        const hasHaulers = myCreeps.some(c => c.memory.role === 'hauler' && !c.spawning);

        if (!hasMiners || !hasHaulers) {
            budget = Math.max(room.energyAvailable, 200);
        } else if (opState === 'EMERGENCY') {
            budget = Math.max(room.energyAvailable, 200);
        }

        return budget;
    }
};

module.exports = spawnPlanner;
