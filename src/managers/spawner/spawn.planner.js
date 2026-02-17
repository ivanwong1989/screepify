const DEFAULT_REQUEST_TTL = 50;

const spawnPlanner = {
    plan: function(room, contractEntries, fulfillment, options) {
        if (!contractEntries || contractEntries.length === 0) return null;
        const unmet = contractEntries.filter(entry => {
            const count = fulfillment[entry.contract.contractId] || 0;
            return count < entry.contract.desired;
        });

        unmet.sort((a, b) => (b.contract.priority || 0) - (a.contract.priority || 0));

        if (unmet.length > 0) {
            debug('spawner', `[Spawner] Contracts unmet: ${unmet.map(e => e.contract.contractId).join(', ')}`);
        } else {
            debug('spawner', `[Spawner] No unmet contracts for ${room.name}`);
            return null;
        }

        unmet.forEach(entry => {
            const desired = entry.contract.desired;
            const fulfilled = fulfillment[entry.contract.contractId] || 0;
            debug('spawner', `[SpawnPlanner] ${room.name} unmet ${entry.contract.contractId} role=${entry.contract.role} bind=${entry.contract.bindMode}:${entry.contract.bindId} desired=${desired} fulfilled=${fulfilled}`);
        });

        const entry = this.selectContract(room, unmet);
        if (!entry) return null;
        debug('spawner', `[SpawnPlanner] ${room.name} pick=${entry.contract.contractId} role=${entry.contract.role} desired=${entry.contract.desired} prio=${entry.contract.priority}`);

        const ticket = this.createTicket(room, entry.contract);
        if (!ticket) return null;
        debug('spawner', `[SpawnPlanner] ${room.name} ticketCreated=${ticket.ticketId} contract=${ticket.contractId}`);

        return this.buildSpawnTicket(entry, room, ticket, options);
    },

    selectContract: function(room, entries) {
        const history = room.memory.spawnHistory || [];
        const MAX_CONSECUTIVE = 2;

        if (history.length >= MAX_CONSECUTIVE) {
            const lastArchetype = history[history.length - 1];
            let consecutive = 0;
            
            for (let i = history.length - 1; i >= 0; i--) {
                if (history[i] === lastArchetype) consecutive++;
                else break;
            }

            if (consecutive >= MAX_CONSECUTIVE) {
                const alternative = entries.find(e => e.contract.role !== lastArchetype);
                if (alternative) {
                    return alternative;
                }
            }
        }

        return entries[0];
    },

    buildSpawnTicket: function(entry, room, ticket, options) {
        const mission = entry.mission;
        const contract = entry.contract;
        const budget = this.computeBudget(room, mission);

        const buildBody = options && options.buildBody;
        const calculateBodyCost = options && options.calculateBodyCost;
        if (!buildBody || !calculateBodyCost) return null;

        const body = buildBody(mission, budget);
        const cost = calculateBodyCost(body);
        debug('spawner', `[SpawnPlanner] ${room.name} body parts=${body.length} cost=${cost} budget=${budget}`);

        const memory = {
            role: contract.role,
            room: room.name,
            taskState: 'init',
            contractId: contract.contractId,
            ticketId: ticket.ticketId,
            bindMode: contract.bindMode,
            bindId: contract.bindId
        };

        if (contract.bindMode !== 'pool' && mission && mission.name) {
            memory.missionName = mission.name;
        }

        return {
            ticketId: ticket.ticketId,
            contractId: contract.contractId,
            homeRoom: room.name,
            role: contract.role,
            bindMode: contract.bindMode,
            bindId: contract.bindId,
            priority: contract.priority,
            body: body,
            cost: cost,
            memory: memory,
            targetRoom: mission && mission.data ? mission.data.targetRoom : null
        };
    },

    computeBudget: function(room, mission) {
        const state = room._state;
        let budget = room.energyCapacityAvailable;

        const cache = global.getRoomCache(room);
        const myCreeps = cache.myCreeps || [];

        const hasMiners = myCreeps.some(c => c.memory.role === 'miner' && !c.spawning);
        const hasHaulers = myCreeps.some(c => c.memory.role === 'hauler' && !c.spawning);

        if (!room.memory.spawner) room.memory.spawner = {};

        const missionName = mission && mission.name ? mission.name : 'unknown';
        if (room.memory.spawner.lastMissionName !== missionName) {
            room.memory.spawner.lastMissionName = missionName;
            room.memory.spawner.waitTicks = 0;
        }

        if (!hasMiners || !hasHaulers) {
            budget = Math.max(room.energyAvailable, 200);
            room.memory.spawner.waitTicks = 0;
            debug('spawner', `[SpawnPlanner] ${room.name} bootstrap budget=${budget}`);
        } else if (state === 'EMERGENCY') {
            budget = Math.max(room.energyAvailable, 200);
            room.memory.spawner.waitTicks = 0;
            debug('spawner', `[SpawnPlanner] ${room.name} emergency budget=${budget}`);
        } else if (room.energyAvailable < room.energyCapacityAvailable) {
            const GRACE_PERIOD = 100;
            room.memory.spawner.waitTicks++;
            
            if (room.memory.spawner.waitTicks > GRACE_PERIOD) {
                budget = Math.max(room.energyAvailable, 200);
                debug('spawner', `[Spawner] Grace period expired for ${missionName} (${room.memory.spawner.waitTicks} ticks). Downgrading budget.`);
            } else {
                budget = room.energyCapacityAvailable;
                if (room.memory.spawner.waitTicks % 20 === 0) {
                    debug('spawner', `[Spawner] Waiting for refill for ${missionName} (${room.memory.spawner.waitTicks}/${GRACE_PERIOD}).`);
                }
            }
        } else {
            room.memory.spawner.waitTicks = 0;
        }

        return budget;
    },

    createTicket: function(room, contract) {
        if (!room.memory.spawner) room.memory.spawner = {};
        if (room.memory.spawner.lastTicketTick === Game.time) return null;
        room.memory.spawner.lastTicketTick = Game.time;

        if (!Memory.spawnTickets) Memory.spawnTickets = {};
        const ticketId = `ticket:${Game.time.toString(36)}:${Math.floor(Math.random() * 100000)}`;
        const ticket = {
            ticketId,
            contractId: contract.contractId,
            homeRoom: contract.homeRoom,
            role: contract.role,
            bindMode: contract.bindMode,
            bindId: contract.bindId,
            state: 'REQUESTED',
            creepName: null,
            spawnRoom: null,
            expiresAt: Game.time + DEFAULT_REQUEST_TTL
        };
        Memory.spawnTickets[ticketId] = ticket;
        debug('spawner', `[SpawnPlanner] ${room.name} store ticket=${ticketId} contract=${contract.contractId}`);

        if (!Memory.rooms) Memory.rooms = {};
        if (!Memory.rooms[contract.homeRoom]) Memory.rooms[contract.homeRoom] = {};
        const index = Memory.rooms[contract.homeRoom].spawnTicketsByKey || {};
        const key = contract.contractId;
        if (!index[key]) index[key] = [];
        index[key].push(ticketId);
        Memory.rooms[contract.homeRoom].spawnTicketsByKey = index;

        return ticket;
    }
};

module.exports = spawnPlanner;
