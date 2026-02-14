/**
 * The Spawner Manager reads the Overseer's contract (Missions).
 * It identifies missions with workforce deficits and spawns creeps to fulfill them.
 * 
 * @param {Room} room
 */
var managerSpawner = {
    run: function(room) {
        const missions = room._missions;
        if (!missions) return;
        const cache = global.getRoomCache(room);
        const myCreeps = cache.myCreeps || [];
        const PRESPAWN_TTL = 80;
        const ECONOMY_ROLES = new Set(['miner', 'remote_miner', 'hauler', 'remote_hauler', 'worker', 'remote_worker', 'mineral_miner']);

        // 1. Identify Deficits
        const spawnQueue = [];
        const nearDeathByRole = Object.create(null);
        const nearDeathByMission = Object.create(null);

        for (const creep of myCreeps) {
            if (!creep.ticksToLive || creep.ticksToLive > PRESPAWN_TTL) continue;
            const role = creep.memory && creep.memory.role;
            if (role) nearDeathByRole[role] = (nearDeathByRole[role] || 0) + 1;
            const missionName = creep.memory && creep.memory.missionName;
            if (missionName) nearDeathByMission[missionName] = (nearDeathByMission[missionName] || 0) + 1;
        }
        
        missions.forEach(mission => {
            // Census data provided by Overseer
            if (!mission.census) return;
            
            const req = mission.requirements || {};
            if (req.spawnFromFleet) return;
            const current = mission.census;
            const archetype = mission.archetype || req.archetype;
            let nearDeathCount = 0;

            if (archetype && ECONOMY_ROLES.has(archetype)) {
                const roleMatch = mission.roleCensus;
                if (roleMatch) {
                    nearDeathCount = nearDeathByRole[roleMatch] || 0;
                } else {
                    nearDeathCount = nearDeathByMission[mission.name] || 0;
                }
            }

            const effectiveCount = Math.max(0, current.count - nearDeathCount);

            if (req.count && effectiveCount < req.count && req.spawn !== false) {
                spawnQueue.push(mission);
            }
        });

        // 2. Sort by Priority
        spawnQueue.sort((a, b) => b.priority - a.priority);

        if (spawnQueue.length > 0) {
            debug('spawner', `[Spawner] Queue: ${spawnQueue.map(m => m.name).join(', ')}`);
        }

        // 3. Execute Spawn
        if (spawnQueue.length > 0) {
            const spawns = (cache.myStructuresByType[STRUCTURE_SPAWN] || []).filter(s => !s.spawning);
            if (spawns.length > 0) {
                const mission = this.selectMission(room, spawnQueue);
                this.spawnCreep(spawns[0], mission, room);
            }
        }
    },

    spawnCreep: function(spawn, mission, room) {
        const state = room._state;
        let budget = room.energyCapacityAvailable;
        
        // --- Contextual Economy Check ---
        const cache = global.getRoomCache(room);
        const myCreeps = cache.myCreeps || [];
        
        // Check for presence of active economy creeps (not spawning)
        const hasMiners = myCreeps.some(c => c.memory.role === 'miner' && !c.spawning);
        const hasHaulers = myCreeps.some(c => c.memory.role === 'hauler' && !c.spawning);
        
        if (!room.memory.spawner) room.memory.spawner = {};
        
        // Reset wait ticks if we switched missions
        if (room.memory.spawner.lastMissionName !== mission.name) {
            room.memory.spawner.lastMissionName = mission.name;
            room.memory.spawner.waitTicks = 0;
        }

        // --- Budget Logic ---

        // 1. Critical Bootstrap: If we lack fundamental economy roles, spawn immediately with what we have.
        if (!hasMiners || !hasHaulers) {
            budget = Math.max(room.energyAvailable, 200);
            room.memory.spawner.waitTicks = 0;
        }
        // 2. Emergency State: Hostiles present, etc.
        else if (state === 'EMERGENCY') {
            budget = Math.max(room.energyAvailable, 200);
            room.memory.spawner.waitTicks = 0;
        }
        // 3. Grace Period Logic: If we have economy but low energy, wait for refill.
        else if (room.energyAvailable < room.energyCapacityAvailable) {
            const GRACE_PERIOD = 100; // Ticks to wait for refill
            room.memory.spawner.waitTicks++;
            
            if (room.memory.spawner.waitTicks > GRACE_PERIOD) {
                budget = Math.max(room.energyAvailable, 200);
                debug('spawner', `[Spawner] Grace period expired for ${mission.name} (${room.memory.spawner.waitTicks} ticks). Downgrading budget.`);
            } else {
                // Maintain full budget to force waiting for refill
                budget = room.energyCapacityAvailable;
                if (room.memory.spawner.waitTicks % 20 === 0) {
                    debug('spawner', `[Spawner] Waiting for refill for ${mission.name} (${room.memory.spawner.waitTicks}/${GRACE_PERIOD}).`);
                }
            }
        } else {
            // Energy is full, proceed with full budget
            room.memory.spawner.waitTicks = 0;
        }

        const body = this.generateBody(mission, budget);
        const cost = this.calculateBodyCost(body);

        if (room.energyAvailable >= cost) {
            const name = `${mission.archetype}_${Game.time.toString(36)}`;
            const memory = {
                role: mission.archetype,
                missionName: mission.name,
                room: room.name,
                taskState: 'init'
            };
            
            const result = spawn.spawnCreep(body, name, { memory: memory });
            if (result === OK) {
                debug('spawner', `[Spawner] Spawning ${name} for ${mission.name} (Cost: ${cost})`);

                if (!room.memory.spawnHistory) room.memory.spawnHistory = [];
                room.memory.spawnHistory.push(mission.archetype);
                if (room.memory.spawnHistory.length > 5) room.memory.spawnHistory.shift();
                room.memory.spawner.waitTicks = 0;
            } else {
                debug('spawner', `[Spawner] Failed to spawn ${name}: ${result}`);
            }
        } else {
            debug('spawner', `[Spawner] Waiting for energy: ${mission.name} (Cost: ${cost}/${room.energyAvailable}) [Budget: ${budget}, State: ${state}]`);
        }
    },

    selectMission: function(room, spawnQueue) {
        const history = room.memory.spawnHistory || [];
        const MAX_CONSECUTIVE = 2;

        if (history.length >= MAX_CONSECUTIVE) {
            const lastArchetype = history[history.length - 1];
            let consecutive = 0;
            
            // Check history for consecutive spawns of the same archetype
            for (let i = history.length - 1; i >= 0; i--) {
                if (history[i] === lastArchetype) consecutive++;
                else break;
            }

            if (consecutive >= MAX_CONSECUTIVE) {
                // Congestion detected: Try to find a mission with a different archetype
                const alternative = spawnQueue.find(m => m.archetype !== lastArchetype);
                if (alternative) {
                    return alternative;
                }
            }
        }

        // Default to the highest priority mission
        return spawnQueue[0];
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
            budget = Math.min(budget, 1000);
        }
        if (archetype === 'dismantler') {
            budget = Math.min(budget, 1500);
        }
        if (archetype === 'worker') {
            budget = Math.min(budget, 1300);
        }
        if (archetype === 'hauler') {
            budget = Math.min(budget, 1300);
        }        
        if (mission.requirements && mission.requirements.body) {
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
        } else if (mission.archetype === 'hauler' || mission.archetype === 'remote_hauler') {
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
        // WORK, CARRY, MOVE x3 (300) Needs high move since we're travelling alot
        let body = [];
        let cost = 0;
        
        while (cost + 300 <= budget && body.length + 7 <= 50) {
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

    sortBody: function(body) {
        const sortOrder = { 
            [TOUGH]: 0, 
            [ATTACK]: 1, [RANGED_ATTACK]: 1, [WORK]: 1, 
            [CARRY]: 2, 
            [MOVE]: 3, 
            [HEAL]: 4 
        };
        return body.sort((a, b) => ((sortOrder[a] !== undefined ? sortOrder[a] : 99) - (sortOrder[b] !== undefined ? sortOrder[b] : 99)));
    },

    calculateBodyCost: function(body) {
        return body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
    }
};

module.exports = managerSpawner;
