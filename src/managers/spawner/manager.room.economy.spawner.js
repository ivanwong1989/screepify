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
        room._spawnCandidates = [];

        // 1. Build contracts + fulfillment from live + inflight supply
        const contractEntries = spawnContracts.buildContracts(room, missions, {
            getBodyStats: (mission, budget) => {
                const archetype = mission && (mission.archetype || (mission.requirements && mission.requirements.archetype));
                return this.checkBody(archetype, budget, mission);
            }
        });
        debug('spawner', `[Spawner] ${room.name} contracts=${contractEntries.length}`);
        if (contractEntries.length === 0) return;

        const fulfillment = spawnCensus.getFulfillment(room, contractEntries, allCreeps || myCreeps);
        debug('spawner', `[Spawner] ${room.name} fulfillment keys=${Object.keys(fulfillment).length}`);
        const buildOptions = {
            buildBody: (mission, budget) => this.generateBody(mission, budget),
            calculateBodyCost: (body) => this.calculateBodyCost(body)
        };

        const candidateToSpawn = spawnPlanner.plan(room, contractEntries, fulfillment, buildOptions);
        if (candidateToSpawn) {
            debug('spawner', `[Spawner] ${room.name} planned contract=${candidateToSpawn.contractId} role=${candidateToSpawn.role} prio=${candidateToSpawn.priority} cost=${candidateToSpawn.cost} deficit=${candidateToSpawn.deficit}`);
            room._spawnCandidates.push(candidateToSpawn);
        } else {
            debug('spawner', `[Spawner] ${room.name} no candidate planned`);
        }
    },

    checkBody: function(type, budget, opts) {
        const archetype = type;

        if (!global._checkBodyCache || global._checkBodyCache.time !== Game.time) {
            global._checkBodyCache = { time: Game.time, byKey: Object.create(null) };
        }

        // Allow callers to influence body generation (e.g. miner mode=mobile)
        // opts can be:
        //  - undefined
        //  - { mode: 'mobile' }  (will be attached to mission.data)
        //  - a full mission-like object (will be used as-is)
        let mission;
        if (opts && typeof opts === 'object' && (opts.archetype || opts.requirements)) {
            mission = opts;
        } else {
            mission = { archetype: archetype };
            if (opts && typeof opts === 'object') mission.data = opts;
        }

        const req = mission && mission.requirements ? mission.requirements : null;
        const data = mission && mission.data ? mission.data : null;
        const cacheKey = [
            archetype || '',
            Number.isFinite(budget) ? budget : 0,
            data && data.mode ? data.mode : '',
            req && Number.isFinite(req.maxCarryParts) ? req.maxCarryParts : '',
            req && Array.isArray(req.body) ? req.body.join('.') : '',
            req && req.bodyMode ? req.bodyMode : ''
        ].join('|');

        const cached = global._checkBodyCache.byKey[cacheKey];
        if (cached) return cached;

        const body = this.generateBody(mission, budget);

        // Single-pass stats (avoid filter() allocations and extra iterations).
        let cost = 0;
        let work = 0;
        let carry = 0;
        let move = 0;
        let claim = 0;

        for (let i = 0; i < body.length; i++) {
            const part = body[i];
            cost += BODYPART_COST[part] || 0;
            if (part === WORK) work++;
            else if (part === CARRY) carry++;
            else if (part === MOVE) move++;
            else if (part === CLAIM) claim++;
        }

        const stats = { body, cost, work, carry, move, claim };
        global._checkBodyCache.byKey[cacheKey] = stats;
        return stats;
    },

    generateBody: function(mission, budget) {
        const archetype = mission && (mission.archetype || (mission.requirements && mission.requirements.archetype));
        // --- HACKISH BODY BUDGET RESTRICTION, TO IMPROVE LATER ---
        if (archetype === 'remote_worker' || archetype === 'remote_hauler') {
            budget = Math.min(budget, 3000);
        }
        if (archetype === 'dismantler') {
            budget = Math.min(budget, 2100);
        }
        if (archetype === 'worker') {
            budget = Math.min(budget, 3000);
        }
        if (archetype === 'hauler' || archetype == 'user_hauler' || archetype === 'coreLaneHauler' || archetype === 'miningLaneHauler') {
            budget = Math.min(budget, 4000);
        } 
        // --- BODY BUDGET END ---       
        if (mission.requirements && mission.requirements.body) {
            if (mission.requirements.bodyMode === 'fixed') {
                const fixedBody = Array.isArray(mission.requirements.body) ? mission.requirements.body.slice() : [];
                return this.sortBody(fixedBody);
            }
            return this.generateMilitaryBody(budget, mission.requirements.body);
        }
        if (mission.archetype === 'miner') {
            // Mobile harvesters need extra mobility early (1W 1C 2M ratio per segment)
            if (mission && mission.data && mission.data.mode === 'mobile') {
                return this.generateMobileMinerBody(budget);
            }
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
        } else if (
            mission.archetype === 'hauler' ||
            mission.archetype === 'remote_hauler' ||
            mission.archetype === 'user_hauler' ||
            mission.archetype === 'coreLaneHauler' ||
            mission.archetype === 'miningLaneHauler'
        ) {
            const maxCarryParts = mission.requirements ? mission.requirements.maxCarryParts : null;
            const includeRepairWorkPart = mission.archetype === 'remote_hauler';
            return this.generateHaulerBody(budget, maxCarryParts, includeRepairWorkPart);
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

        // Track counts as we build (no filter() in loop)
        let workCount = 1; // base has 1 WORK

        // Max WORK for a standard source is 5, we use 7 for our inefficiencies
        while (cost + 100 <= budget && workCount < 7) {
            body.push(WORK);
            cost += 100;
            workCount++;
        }

        return this.sortBody(body);
    },

    generateMobileMinerBody: function(budget) {
        // Mobile miners: 1 WORK, 1 CARRY, 2 MOVE per segment (250)
        // Keep WORK modest (cap at 5) so we don't over-invest in stationary mining while walking.
        const segment = [WORK, CARRY, MOVE, MOVE];
        if (budget < 250) {
            if (budget >= 200) return this.sortBody([WORK, CARRY, MOVE]);
            if (budget >= 150) return this.sortBody([WORK, MOVE]);
            if (budget >= 100) return this.sortBody([WORK]);
            return this.sortBody([MOVE]);
        }

        let body = segment.slice();
        let cost = 250;
        let workCount = 1;
        const MAX_WORK = 5;

        while (cost + 250 <= budget && body.length + 4 <= 50 && workCount + 1 <= MAX_WORK) {
            body = body.concat(segment);
            cost += 250;
            workCount += 1;
        }

        return this.sortBody(body);
    },


    generateRemoteMinerBody: function (budget) {
        // Remote miners travel: extra MOVE compared to local static miners.
        // Base: WORK, CARRY, MOVE, MOVE (250)
        if (budget < 250) {
            if (budget >= 200) return this.sortBody([WORK, CARRY, MOVE]); // 200
            if (budget >= 150) return this.sortBody([WORK, MOVE]);        // 150
            if (budget >= 100) return this.sortBody([WORK]);              // 100
            return this.sortBody([MOVE]);                                 // 50
        }

        let body = [WORK, CARRY, MOVE, MOVE];
        let cost = 250;
        let workCount = 1;
        const MAX_WORK = 7;

        // Add WORK in lockstep with MOVE so travel speed scales with body size.
        while (cost + 150 <= budget && body.length + 2 <= 50 && workCount < MAX_WORK) {
            body.push(WORK, MOVE);
            cost += 150;
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

        while (cost + 250 <= budget && body.length + 3 <= 50) {
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

    generateHaulerBody: function(budget, maxCarryParts, includeRepairWorkPart) {
        const withRepairWorkPart = !!includeRepairWorkPart;
        const canAddRepairSegment = withRepairWorkPart && budget >= 250;
        const reservedParts = canAddRepairSegment ? 2 : 0;
        const reservedCost = canAddRepairSegment ? 150 : 0;

        // CARRY, MOVE (100)
        let body = [];
        let cost = 0;
        let carryCount = 0;
        const carryCap = Number.isFinite(maxCarryParts) && maxCarryParts > 0 ? maxCarryParts : Infinity;

        while (
            cost + 100 <= (budget - reservedCost) &&
            body.length + 2 <= (50 - reservedParts) &&
            carryCount < carryCap
        ) {
            body.push(CARRY);
            body.push(MOVE);
            cost += 100;
            carryCount++;
        }

        if (canAddRepairSegment && body.length > 0 && body.length + 2 <= 50 && cost + 150 <= budget) {
            body.push(WORK);
            body.push(MOVE);
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
        
        while (cost + 400 <= budget && body.length + 6 <= 50) {
            body.push(WORK);
            body.push(WORK);
            body.push(CARRY);
            body.push(MOVE);
            body.push(MOVE);
            body.push(MOVE);
            cost += 400;
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
