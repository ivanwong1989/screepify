const NEAR_DEATH_BUFFER = 20;

const getNearDeathLeadTicks = (leadTicks) => {
    return Number.isFinite(leadTicks) && leadTicks >= 0
        ? leadTicks
        : NEAR_DEATH_BUFFER;
};

const getTickCache = (key) => {
    if (!global[key] || global[key].time !== Game.time) {
        global[key] = { time: Game.time, map: Object.create(null) };
    }
    return global[key].map;
};

const getHomeSpawnBusyTicks = (homeRoomName) => {
    if (!homeRoomName || typeof getRoomCache !== 'function') return 0;

    const byRoom = getTickCache('_spawnBusyTicksByRoomCache');
    if (byRoom[homeRoomName] !== undefined) return byRoom[homeRoomName];

    const room = Game.rooms[homeRoomName];
    if (!room) {
        byRoom[homeRoomName] = 0;
        return 0;
    }

    const cache = getRoomCache(room);
    const spawns = (cache && cache.myStructuresByType && cache.myStructuresByType[STRUCTURE_SPAWN]) || [];
    if (!spawns.length) {
        byRoom[homeRoomName] = 0;
        return 0;
    }

    let minRemaining = Infinity;
    let hasBusy = false;
    for (const spawn of spawns) {
        if (!spawn || !spawn.spawning) continue;
        const remaining = spawn.spawning.remainingTime || 0;
        if (remaining <= 0) continue;
        hasBusy = true;
        if (remaining < minRemaining) minRemaining = remaining;
    }

    const value = hasBusy ? minRemaining : 0;
    byRoom[homeRoomName] = value;
    return value;
};

const shouldIgnoreForNearDeath = (creep, role, leadTicks, homeRoomName) => {
    if (!creep || !role) return false;
    if (
        role !== 'simple_miner' &&
        role !== 'miner' &&
        role !== 'hauler' &&
        role !== 'coreLaneHauler' &&
        role !== 'simpleHaulerCore' &&
        role !== 'simpleMiningHauler'
    ) return false;
    if (!Number.isFinite(creep.ticksToLive)) return false;

    const lead = getNearDeathLeadTicks(leadTicks);
    const key = `${creep.name}|${role}|${lead}`;
    const nearDeathCache = getTickCache('_spawnNearDeathCache');
    if (nearDeathCache[key] !== undefined) return nearDeathCache[key];

    const spawnTime = creep.body ? creep.body.length * 3 : 0;
    const spawnBusyTicks = getHomeSpawnBusyTicks(homeRoomName);
    const threshold = spawnTime + lead + spawnBusyTicks;
    const shouldIgnore = creep.ticksToLive <= threshold;

    nearDeathCache[key] = shouldIgnore;
    return shouldIgnore;
};

const initContractContext = (contractEntries) => {
    const context = {
        contractIds: new Set(),
        byId: Object.create(null),
        poolIndex: Object.create(null),
        fulfillment: Object.create(null)
    };

    for (const entry of contractEntries) {
        const contract = entry && entry.contract;
        if (!contract || !contract.contractId) continue;

        const contractId = contract.contractId;
        context.contractIds.add(contractId);
        context.byId[contractId] = contract;
        context.fulfillment[contractId] = { live: 0, inflight: 0, effective: 0 };

        if (contract.bindMode === 'pool') {
            const poolKey = `${contract.homeRoom || ''}|${contract.role || ''}`;
            if (!context.poolIndex[poolKey]) context.poolIndex[poolKey] = contractId;
        }
    }

    return context;
};

const resolveContractId = (memory, context) => {
    if (!memory) return null;

    const direct = memory.contractId;
    if (direct && context.contractIds.has(direct)) return direct;

    const poolKey = `${memory.room || ''}|${memory.role || ''}`;
    const pooled = context.poolIndex[poolKey];
    if (pooled && context.contractIds.has(pooled)) return pooled;

    return null;
};

const spawnCensus = {
    getFulfillment: function(room, contractEntries, creepsFallback) {
        const context = initContractContext(contractEntries || []);
        const fulfillment = context.fulfillment;
        const countedLive = new Set();
        const creeps = creepsFallback || Object.values(Game.creeps);

        for (const creep of creeps) {
            if (!creep || !creep.my) continue;

            const contractId = resolveContractId(creep.memory, context);
            if (!contractId) continue;
            if (countedLive.has(creep.name)) continue;
            countedLive.add(creep.name);

            const contract = context.byId[contractId] || {};
            const role = contract.role || (creep.memory && creep.memory.role);
            const homeRoomName = contract.homeRoom || (creep.memory && creep.memory.room);
            const replaceLeadTicks = Number.isFinite(contract.replaceLeadTicks) ? contract.replaceLeadTicks : null;
            const nearDeathIgnored = shouldIgnoreForNearDeath(creep, role, replaceLeadTicks, homeRoomName);

            fulfillment[contractId].live += 1;
            if (!nearDeathIgnored) fulfillment[contractId].effective += 1;
        }

        for (const roomName in Game.rooms) {
            const ownedRoom = Game.rooms[roomName];
            if (!ownedRoom || !ownedRoom.controller || !ownedRoom.controller.my) continue;

            let spawns = null;
            if (typeof getRoomCache === 'function') {
                const cache = getRoomCache(ownedRoom);
                spawns = (cache && cache.myStructuresByType && cache.myStructuresByType[STRUCTURE_SPAWN]) || null;
            }
            if (!spawns) spawns = ownedRoom.find(FIND_MY_SPAWNS);

            for (const spawn of spawns) {
                if (!spawn || !spawn.spawning || !spawn.spawning.name) continue;

                const memory = Memory.creeps && Memory.creeps[spawn.spawning.name];
                const contractId = resolveContractId(memory, context);
                if (!contractId) continue;

                fulfillment[contractId].inflight += 1;
                fulfillment[contractId].effective += 1;
            }
        }

        debug('spawner', `[SpawnCensus] ${room.name} contracts=${Object.keys(fulfillment).length}`);
        return fulfillment;
    }
};

module.exports = spawnCensus;

