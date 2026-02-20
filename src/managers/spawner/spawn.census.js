const NEAR_DEATH_BUFFER = 20;

const shouldIgnoreForNearDeath = (creep, role) => {
    if (!creep || !role) return false;
    if (role !== 'miner' && role !== 'hauler') return false;
    if (!Number.isFinite(creep.ticksToLive)) return false;
    const spawnTime = creep.body ? creep.body.length * 3 : 0;
    const threshold = spawnTime + NEAR_DEATH_BUFFER;
    return creep.ticksToLive <= threshold;
};

const spawnCensus = {
    pruneTickets: function(room, contractEntries) {
        if (!Memory.spawnTickets) return;
        const tickets = Memory.spawnTickets;
        const contractIds = new Set(contractEntries.map(e => e.contract.contractId));
        const desiredByContract = Object.create(null);
        const roleByContract = Object.create(null);
        for (const entry of contractEntries) {
            desiredByContract[entry.contract.contractId] = entry.contract.desired || 0;
            roleByContract[entry.contract.contractId] = entry.contract.role;
        }
        const roomIndex = Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].spawnTicketsByKey
            ? Memory.rooms[room.name].spawnTicketsByKey
            : null;

        const isActiveTicket = (ticket) => {
            if (!ticket) return false;
            if (!contractIds.has(ticket.contractId)) return false;
            if (ticket.expiresAt && ticket.expiresAt <= Game.time) return false;
            if (!['REQUESTED', 'SPAWNING', 'EN_ROUTE', 'ACTIVE'].includes(ticket.state)) return false;
            return true;
        };

        const activeCounts = Object.create(null);
        const requestedByContract = Object.create(null);

        const countTicket = (ticketId, ticket) => {
            if (!isActiveTicket(ticket)) return;
            const contractId = ticket.contractId;
            if (ticket.creepName) {
                const role = roleByContract[contractId] || ticket.role;
                const creep = Game.creeps[ticket.creepName];
                if (shouldIgnoreForNearDeath(creep, role)) return;
            }
            activeCounts[contractId] = (activeCounts[contractId] || 0) + 1;
            if (ticket.state === 'REQUESTED' && !ticket.creepName) {
                if (!requestedByContract[contractId]) requestedByContract[contractId] = [];
                requestedByContract[contractId].push(ticketId);
            }
        };

        if (roomIndex) {
            for (const contractId of contractIds) {
                const list = roomIndex[contractId];
                if (!list || list.length === 0) continue;
                for (let i = list.length - 1; i >= 0; i--) {
                    const ticketId = list[i];
                    const ticket = tickets[ticketId];
                    if (!ticket || ticket.contractId !== contractId) {
                        list.splice(i, 1);
                        continue;
                    }
                    countTicket(ticketId, ticket);
                }
            }
        } else {
            for (const id in tickets) {
                const ticket = tickets[id];
                countTicket(id, ticket);
            }
        }

        const removeTicket = (ticketId, ticket) => {
            delete tickets[ticketId];
            const home = ticket && ticket.homeRoom;
            const contractId = ticket && ticket.contractId;
            if (home && contractId && Memory.rooms && Memory.rooms[home] && Memory.rooms[home].spawnTicketsByKey) {
                const index = Memory.rooms[home].spawnTicketsByKey;
                const list = index[contractId];
                if (list && list.length > 0) {
                    index[contractId] = list.filter(tid => tid !== ticketId);
                }
            }
        };

        let prunedTotal = 0;
        const prunedByContract = [];

        for (const contractId in activeCounts) {
            const desired = desiredByContract[contractId] || 0;
            const active = activeCounts[contractId];
            if (active <= desired) continue;

            let over = active - desired;
            const requested = requestedByContract[contractId] || [];
            // Remove excess REQUESTED tickets first (unassigned queue)
            while (over > 0 && requested.length > 0) {
                const ticketId = requested.pop();
                const ticket = tickets[ticketId];
                if (ticket) removeTicket(ticketId, ticket);
                prunedTotal++;
                over--;
            }

            if (active > desired && (requestedByContract[contractId] || []).length > 0) {
                const removed = Math.min(active - desired, (requestedByContract[contractId] || []).length);
                if (removed > 0) {
                    prunedByContract.push(`${contractId} removed=${removed} active=${active} desired=${desired}`);
                }
            }
        }

        if (prunedTotal > 0) {
            debug('spawner', `[SpawnCensus] ${room.name} prunedTickets=${prunedTotal}`);
            if (prunedByContract.length > 0) {
                debug('spawner', `[SpawnCensus] ${room.name} prunedByContract ${prunedByContract.join('; ')}`);
            }
        }
    },
    getFulfillment: function(room, contractEntries, creepsFallback, spawningNamesFallback) {
        const contractIds = new Set(contractEntries.map(e => e.contract.contractId));
        const counts = Object.create(null);
        const countedCreepNamesByContract = Object.create(null);
        const roleByContract = Object.create(null);
        debug('spawner', `[SpawnCensus] ${room.name} contracts=${contractEntries.length}`);

        for (const entry of contractEntries) {
            counts[entry.contract.contractId] = 0;
            countedCreepNamesByContract[entry.contract.contractId] = new Set();
            roleByContract[entry.contract.contractId] = entry.contract.role;
        }

        let spawningNames = spawningNamesFallback;
        if (!spawningNames && global._spawningNamesCache && global._spawningNamesCache.time === Game.time) {
            spawningNames = global._spawningNamesCache.names;
        }
        if (!spawningNames) {
            spawningNames = new Set();
            for (const rn in Game.rooms) {
                const r = Game.rooms[rn];
                if (!r.controller || !r.controller.my) continue;
                const spawns = r.find(FIND_MY_SPAWNS);
                for (const s of spawns) {
                    if (s.spawning) spawningNames.add(s.spawning.name);
                }
            }
        }

        const tickets = Memory.spawnTickets || {};
        const roomIndex = Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].spawnTicketsByKey
            ? Memory.rooms[room.name].spawnTicketsByKey
            : null;
        const poolIndex = Object.create(null);
        for (const entry of contractEntries) {
            const contract = entry.contract;
            if (!contract || contract.bindMode !== 'pool') continue;
            const key = `${contract.homeRoom}|${contract.role}`;
            if (!poolIndex[key]) poolIndex[key] = contract.contractId;
        }
        const isActiveTicket = (ticket) => {
            if (!ticket) return false;
            if (!contractIds.has(ticket.contractId)) return false;
            if (ticket.expiresAt && ticket.expiresAt <= Game.time) return false;
            if (!['REQUESTED', 'SPAWNING', 'EN_ROUTE', 'ACTIVE'].includes(ticket.state)) return false;
            return true;
        };

        const countFulfillmentTicket = (ticketId, ticket, contractId) => {
            if (!isActiveTicket(ticket)) return;
            if (ticket.creepName) {
                const role = roleByContract[contractId] || ticket.role;
                const creep = Game.creeps[ticket.creepName];
                if (shouldIgnoreForNearDeath(creep, role)) return;
            }
            counts[contractId] = (counts[contractId] || 0) + 1;
            if (ticket.creepName) {
                countedCreepNamesByContract[contractId].add(ticket.creepName);
            }
        };

        if (roomIndex) {
            for (const contractId of contractIds) {
                const list = roomIndex[contractId];
                if (!list || list.length === 0) continue;
                for (let i = list.length - 1; i >= 0; i--) {
                    const ticketId = list[i];
                    const ticket = tickets[ticketId];
                    if (!ticket || ticket.contractId !== contractId) {
                        list.splice(i, 1);
                        continue;
                    }
                    countFulfillmentTicket(ticketId, ticket, contractId);
                }
            }
        } else {
            for (const id in tickets) {
                const ticket = tickets[id];
                if (!ticket || !contractIds.has(ticket.contractId)) continue;
                countFulfillmentTicket(id, ticket, ticket.contractId);
            }
        }
        debug('spawner', `[SpawnCensus] ${room.name} ticketsCounted=${Object.values(counts).reduce((a,b)=>a+b,0)}`);

        const creeps = creepsFallback || Object.values(Game.creeps);
        let creepsCounted = 0;
        for (const creep of creeps) {
            if (!creep || !creep.my) continue;
            const contractId = creep.memory && creep.memory.contractId;
            if (contractId && contractIds.has(contractId)) {
                const role = roleByContract[contractId] || creep.memory.role;
                if (shouldIgnoreForNearDeath(creep, role)) continue;
                const ticketId = creep.memory && creep.memory.ticketId;
                const ticket = ticketId ? tickets[ticketId] : null;
                if (ticket && ticket.contractId === contractId && isActiveTicket(ticket)) continue;
                const counted = countedCreepNamesByContract[contractId];
                if (counted && counted.has(creep.name)) continue;
                counts[contractId] = (counts[contractId] || 0) + 1;
                creepsCounted++;
                continue;
            }

            const home = creep.memory && creep.memory.room;
            const role = creep.memory && creep.memory.role;
            if (!home || !role) continue;
            const poolContractId = poolIndex[`${home}|${role}`];
            if (!poolContractId || !contractIds.has(poolContractId)) continue;
            if (shouldIgnoreForNearDeath(creep, role)) continue;
            const counted = countedCreepNamesByContract[poolContractId];
            if (counted && counted.has(creep.name)) continue;
            counts[poolContractId] = (counts[poolContractId] || 0) + 1;
            if (counted) counted.add(creep.name);
            creepsCounted++;
        }
        debug('spawner', `[SpawnCensus] ${room.name} creepsCounted=${creepsCounted}`);

        const refreshTicketState = (ticketId, ticket, contractId) => {
            if (!ticket) return;
            if (!contractIds.has(contractId)) return;
            if (ticket.creepName && spawningNames && spawningNames.has(ticket.creepName)) {
                if (ticket.state !== 'SPAWNING') ticket.state = 'SPAWNING';
            } else if (ticket.creepName && Game.creeps[ticket.creepName]) {
                if (ticket.state === 'REQUESTED' || ticket.state === 'SPAWNING') {
                    ticket.state = 'EN_ROUTE';
                }
            } else if (ticket.creepName) {
                ticket.creepName = null;
                ticket.spawnRoom = null;
                ticket.state = 'REQUESTED';
                ticket.expiresAt = Math.max(ticket.expiresAt || 0, Game.time + 3);
            }
        };

        if (roomIndex) {
            for (const contractId of contractIds) {
                const list = roomIndex[contractId];
                if (!list || list.length === 0) continue;
                for (let i = list.length - 1; i >= 0; i--) {
                    const ticketId = list[i];
                    const ticket = tickets[ticketId];
                    if (!ticket || ticket.contractId !== contractId) {
                        list.splice(i, 1);
                        continue;
                    }
                    refreshTicketState(ticketId, ticket, contractId);
                }
            }
        } else {
            for (const id in tickets) {
                const ticket = tickets[id];
                if (!ticket || !contractIds.has(ticket.contractId)) continue;
                refreshTicketState(id, ticket, ticket.contractId);
            }
        }

        return counts;
    }
};

module.exports = spawnCensus;
