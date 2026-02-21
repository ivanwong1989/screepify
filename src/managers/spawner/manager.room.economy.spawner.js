/**
 * The Spawner Manager reads the Overseer's contract (Missions).
 * It identifies missions with workforce deficits and spawns creeps to fulfill them.
 * 
 * @param {Room} room
 */
const spawnContracts = require('managers_spawner_spawn.contracts');
const spawnCensus = require('managers_spawner_spawn.census');
const spawnPlanner = require('managers_spawner_spawn.planner');

var managerSpawner = {
    run: function(room, allCreeps) {
        const missions = room._missions;
        if (!missions) return;
        const cache = global.getRoomCache(room);
        const myCreeps = cache.myCreeps || [];
        room._spawnTicketsToRequest = [];
        const addedTicketIds = new Set();

        // 1. Build contracts + fulfillment using tickets
        const contractEntries = spawnContracts.buildContracts(room, missions);
        debug('spawner', `[Spawner] ${room.name} contracts=${contractEntries.length}`);
        if (contractEntries.length === 0) return;

        spawnCensus.pruneTickets(room, contractEntries);
        const spawningNames = global._spawningNamesCache && global._spawningNamesCache.time === Game.time
            ? global._spawningNamesCache.names
            : null;
        const fulfillment = spawnCensus.getFulfillment(room, contractEntries, allCreeps || myCreeps, spawningNames);
        debug('spawner', `[Spawner] ${room.name} fulfillment keys=${Object.keys(fulfillment).length}`);
        const buildOptions = {
            buildBody: (mission, budget) => this.generateBody(mission, budget),
            calculateBodyCost: (body) => this.calculateBodyCost(body)
        };

        const ticketToSpawn = spawnPlanner.plan(room, contractEntries, fulfillment, buildOptions);
        if (ticketToSpawn) {
            debug('spawner', `[Spawner] ${room.name} planned ticket=${ticketToSpawn.ticketId} contract=${ticketToSpawn.contractId} role=${ticketToSpawn.role} prio=${ticketToSpawn.priority} cost=${ticketToSpawn.cost}`);
            room._spawnTicketsToRequest.push(ticketToSpawn);
            addedTicketIds.add(ticketToSpawn.ticketId);
        } else {
            debug('spawner', `[Spawner] ${room.name} no ticket planned`);
        }

        // 2. Add pending REQUESTED tickets from Memory as durable backlog.
        const tickets = Memory.spawnTickets;
        if (tickets) {
            const entriesById = Object.create(null);
            for (const entry of contractEntries) {
                entriesById[entry.contract.contractId] = entry;
            }
            const roomIndex = Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].spawnTicketsByKey
                ? Memory.rooms[room.name].spawnTicketsByKey
                : null;

            let backlogAdded = 0;
            const tryAddBacklog = (ticket, entry) => {
                if (!ticket || ticket.state !== 'REQUESTED') return false;
                if (ticket.expiresAt && ticket.expiresAt <= Game.time) return false;
                if (ticket.homeRoom !== room.name) return false;
                if (addedTicketIds.has(ticket.ticketId)) return false;
                const spawnTicket = (ticket.body && ticket.cost && ticket.memory) ? {
                    ticketId: ticket.ticketId,
                    contractId: ticket.contractId,
                    homeRoom: ticket.homeRoom,
                    role: ticket.role || entry.contract.role,
                    bindMode: ticket.bindMode || entry.contract.bindMode,
                    bindId: ticket.bindId || entry.contract.bindId,
                    priority: Number.isFinite(ticket.priority) ? ticket.priority : entry.contract.priority,
                    body: ticket.body,
                    cost: ticket.cost,
                    memory: ticket.memory,
                    targetRoom: ticket.targetRoom || (entry.mission && entry.mission.data ? entry.mission.data.targetRoom : null)
                } : spawnPlanner.buildSpawnTicket(entry, room, ticket, buildOptions);

                if (spawnTicket) {
                    room._spawnTicketsToRequest.push(spawnTicket);
                    addedTicketIds.add(ticket.ticketId);
                    return true;
                }
                return false;
            };

            if (roomIndex) {
                for (const contractId in entriesById) {
                    const entry = entriesById[contractId];
                    const list = roomIndex[contractId];
                    if (!list || list.length === 0) continue;
                    for (let i = list.length - 1; i >= 0; i--) {
                        const ticketId = list[i];
                        const ticket = tickets[ticketId];
                        if (!ticket || ticket.contractId !== contractId) {
                            list.splice(i, 1);
                            continue;
                        }
                        if (tryAddBacklog(ticket, entry)) backlogAdded++;
                    }
                }
            } else {
                for (const id in tickets) {
                    const ticket = tickets[id];
                    if (!ticket) continue;
                    const entry = entriesById[ticket.contractId];
                    if (!entry) continue;
                    if (tryAddBacklog(ticket, entry)) backlogAdded++;
                }
            }

            if (backlogAdded > 0) {
                debug('spawner', `[Spawner] ${room.name} backlog REQUESTED added=${backlogAdded}`);
            }
        }
    },

    checkBody: function(type, budget) {
        let archetype = type;

        const mission = { archetype: archetype };
        const body = this.generateBody(mission, budget);
        const cost = this.calculateBodyCost(body);
        
        return {
            body: body,
            cost: cost,
            work: body.filter(p => p === WORK).length,
            carry: body.filter(p => p === CARRY).length,
            move: body.filter(p => p === MOVE).length
        };
    },

    generateBody: function(mission, budget) {
        const archetype = mission && (mission.archetype || (mission.requirements && mission.requirements.archetype));
        if (archetype === 'remote_worker' || archetype === 'remote_hauler') {
            budget = Math.min(budget, 1200);
        }
        if (archetype === 'dismantler') {
            budget = Math.min(budget, 2100);
        }
        if (archetype === 'worker') {
            budget = Math.min(budget, 1300);
        }
        if (archetype === 'hauler') {
            budget = Math.min(budget, 1300);
        }        
        if (mission.requirements && mission.requirements.body) {
            if (mission.requirements.bodyMode === 'fixed') {
                const fixedBody = Array.isArray(mission.requirements.body) ? mission.requirements.body.slice() : [];
                return this.sortBody(fixedBody);
            }
            return this.generateMilitaryBody(budget, mission.requirements.body);
        }
        if (mission.archetype === 'miner') {
            return this.generateMinerBody(budget);
        } else if (mission.archetype === 'remote_miner') {
            return this.generateRemoteMinerBody(budget);
        } else if (mission.archetype === 'mineral_miner') {
            return this.generateMineralMinerBody(budget);
        } else if (mission.archetype === 'scout') {
            return this.generateScoutBody(budget);
        } else if (mission.archetype === 'dismantler') {
            return this.generateDismantlerBody(budget);
        } else if (mission.archetype === 'reserver') {
            return this.generateReserverBody(budget);
        } else if (mission.archetype === 'claimer') {
            return this.generateClaimerBody(budget);
        } else if (mission.archetype === 'hauler' || mission.archetype === 'remote_hauler' || mission.archetype === 'user_hauler') {
            const maxCarryParts = mission.requirements ? mission.requirements.maxCarryParts : null;
            return this.generateHaulerBody(budget, maxCarryParts);
        } else if (mission.archetype == 'remote_worker') {
            return this.generateRemoteWorkerBody(budget);
        } else {
            return this.generateWorkerBody(budget);
        }
    },

    generateMilitaryBody: function(budget, pattern) {
        const cost = this.calculateBodyCost(pattern);
        const maxSegments = Math.floor(budget / cost);
        const count = Math.min(maxSegments, Math.floor(50 / pattern.length));
        
        let body = [];
        for (let i = 0; i < count; i++) {
            body = body.concat(pattern);
        }
        
        return this.sortBody(body);
    },

    generateMinerBody: function(budget) {
        // Base: WORK, CARRY, MOVE (200)
        let body = [WORK, CARRY, MOVE];
        let cost = 200;
        
        // Max WORK for a standard source is 5
        while (cost + 100 <= budget && body.filter(p => p === WORK).length < 5) {
            body.push(WORK);
            cost += 100;
        }
        
        return this.sortBody(body);
    },

    generateRemoteMinerBody: function(budget) {
        // Remote miners travel: extra MOVE compared to local static miners.
        // Base: WORK, CARRY, MOVE, MOVE (250)
        if (budget < 250) {
            if (budget >= 200) return this.sortBody([WORK, CARRY, MOVE]);
            if (budget >= 150) return this.sortBody([WORK, MOVE]);
            if (budget >= 100) return this.sortBody([WORK]);
            return this.sortBody([MOVE]);
        }

        let body = [WORK, CARRY, MOVE, MOVE];
        let cost = 250;
        let workCount = 1;
        const MAX_WORK = 5;

        // Segment: WORK, WORK, MOVE (250)
        while (cost + 250 <= budget && body.length + 3 <= 50 && workCount + 2 <= MAX_WORK) {
            body.push(WORK, WORK, MOVE);
            cost += 250;
            workCount += 2;
        }

        // If budget allows, add a final WORK to approach 5 total.
        if (workCount < MAX_WORK && cost + 100 <= budget && body.length + 1 <= 50) {
            body.push(WORK);
            cost += 100;
            workCount += 1;
        }

        return this.sortBody(body);
    },

    generateMineralMinerBody: function(budget) {
        // Self-hauling mineral miner: enough CARRY for trips + MOVE for mobility
        // Segment: WORK, CARRY, MOVE, MOVE (250)
        const segment = [WORK, CARRY, MOVE, MOVE];
        let body = [];
        let cost = 0;
        let carryCount = 0;
        const MAX_CARRY = 6;

        while (cost + 250 <= budget && body.length + 4 <= 50 && carryCount < MAX_CARRY) {
            body = body.concat(segment);
            cost += 250;
            carryCount++;
        }

        if (body.length === 0) {
            if (budget >= 300) return this.sortBody([WORK, CARRY, MOVE, MOVE]);
            return this.sortBody([WORK, CARRY, MOVE]);
        }

        return this.sortBody(body);
    },

    generateScoutBody: function(budget) {
        //if (budget >= 100) return [MOVE, MOVE]; // no need to spend so much on a disposable periodic scout
        return [MOVE];
    },

    generateDismantlerBody: function(budget) {
        // Dismantling is WORK-based. No CARRY parts needed.
        // Segment: WORK, WORK, MOVE (250)
        const segment = [WORK, MOVE];
        let body = [];
        let cost = 0;
        const MAX_COST = 1500;

        while (cost + 250 <= budget && body.length + 3 <= 50 && cost < MAX_COST) {
            body = body.concat(segment);
            cost += 250;
        }

        if (body.length === 0) {
            if (budget >= 150) return this.sortBody([WORK, MOVE]);
            if (budget >= 100) return this.sortBody([WORK]);
            return this.sortBody([MOVE]);
        }

        return this.sortBody(body);
    },

    generateReserverBody: function(budget) {
        // Reserving is CLAIM-based. Segment: CLAIM, MOVE (650)
        const segment = [CLAIM, MOVE];
        const segmentCost = 650;
        const segments = Math.max(1, Math.min(2, Math.floor(budget / segmentCost)));
        let body = [];
        for (let i = 0; i < segments; i++) {
            body = body.concat(segment);
        }
        return this.sortBody(body);
    },

    generateClaimerBody: function(budget) {
        return [CLAIM, MOVE];
    },

    generateHaulerBody: function(budget, maxCarryParts) {
        // CARRY, MOVE (100)
        let body = [];
        let cost = 0;
        let carryCount = 0;
        const carryCap = Number.isFinite(maxCarryParts) && maxCarryParts > 0 ? maxCarryParts : Infinity;

        while (cost + 100 <= budget && body.length + 2 <= 50 && carryCount < carryCap) {
            body.push(CARRY);
            body.push(MOVE);
            cost += 100;
            carryCount++;
        }

        if (body.length === 0) return [CARRY, MOVE];
        return this.sortBody(body);
    },

    generateWorkerBody: function(budget) {
        // WORK, CARRY, MOVE (200)
        let body = [];
        let cost = 0;
        
        while (cost + 200 <= budget && body.length + 3 <= 50) {
            body.push(WORK);
            body.push(CARRY);
            body.push(MOVE);
            cost += 200;
        }
        
        if (body.length === 0) return [WORK, CARRY, MOVE];

        return this.sortBody(body);
    },

    generateRemoteWorkerBody: function(budget) {
        // WORK, WORK, CARRY, MOVE x3 (400) Needs high move since we're travelling alot
        let body = [];
        let cost = 0;
        
        while (cost + 400 <= budget && body.length + 7 <= 50) {
            body.push(WORK);
            body.push(WORK);
            body.push(CARRY);
            body.push(MOVE);
            body.push(MOVE);
            body.push(MOVE);
            cost += 300;
        }
        
        if (body.length === 0) return [WORK, CARRY, MOVE];

        return this.sortBody(body);
    },

    sortBody: function (body) {
        const sortOrder = { 
            [TOUGH]: 0, 
            [ATTACK]: 1, [RANGED_ATTACK]: 1, [WORK]: 1, 
            [CARRY]: 2, 
            [HEAL]: 3,
            [MOVE]: 4 
        };

        body.sort(function (a, b) {
            var orderA = sortOrder[a] !== undefined ? sortOrder[a] : 99;
            var orderB = sortOrder[b] !== undefined ? sortOrder[b] : 99;
            return orderA - orderB;
        });

        // Ensure at least 1 HEAL at the end
        var healIndex = body.indexOf(HEAL);
        if (healIndex !== -1) {
            body.splice(healIndex, 1); // remove one HEAL
            body.push(HEAL);           // put it at the tail
        }

        return body;
    },


    calculateBodyCost: function(body) {
        return body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
    }
};

module.exports = managerSpawner;
