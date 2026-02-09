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

        // 1. Identify Deficits
        const spawnQueue = [];
        
        missions.forEach(mission => {
            // Census data provided by Overseer
            if (!mission.census) return;
            
            const req = mission.requirements || {};
            const current = mission.census;

            if (req.count && current.count < req.count && req.spawn !== false) {
                spawnQueue.push(mission);
            }
        });

        // 2. Sort by Priority
        spawnQueue.sort((a, b) => b.priority - a.priority);

        if (spawnQueue.length > 0) {
            log(`[Spawner] Queue: ${spawnQueue.map(m => m.name).join(', ')}`);
        }

        // 3. Execute Spawn
        if (spawnQueue.length > 0) {
            const spawns = room.find(FIND_MY_SPAWNS).filter(s => !s.spawning);
            if (spawns.length > 0) {
                const mission = this.selectMission(room, spawnQueue);
                this.spawnCreep(spawns[0], mission, room);
            }
        }
    },

    spawnCreep: function(spawn, mission, room) {
        const state = room._state;
        let budget = room.energyCapacityAvailable;
        
        // In EMERGENCY, spawn as soon as we have min energy (300).
        if (state === 'EMERGENCY') {
            budget = Math.max(room.energyAvailable, 200);
        }
        // If we have 0 creeps for this mission (bootstrapping), use current energy
        // to ensure we get at least one creep out to start working.
        else if (mission.census.count === 0) {
            budget = Math.max(room.energyAvailable, 200);
        }
        // PREVENT DEADLOCK: If we are trying to spawn a critical economy creep (miner/hauler)
        // and we are unable to reach full capacity (waiting), downgrade to available energy.
        else if (['miner', 'hauler'].includes(mission.archetype) && room.energyAvailable < budget) {
            budget = Math.max(room.energyAvailable, 200);
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
                log(`[Spawner] Spawning ${name} for ${mission.name} (Cost: ${cost})`);

                if (!room.memory.spawnHistory) room.memory.spawnHistory = [];
                room.memory.spawnHistory.push(mission.archetype);
                if (room.memory.spawnHistory.length > 5) room.memory.spawnHistory.shift();
            } else {
                log(`[Spawner] Failed to spawn ${name}: ${result}`);
            }
        } else {
            log(`[Spawner] Waiting for energy: ${mission.name} (Cost: ${cost}/${room.energyAvailable}) [Budget: ${budget}, State: ${state}]`);
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
        if (mission.archetype === 'miner') {
            return this.generateMinerBody(budget);
        } else if (mission.archetype === 'hauler') {
            return this.generateHaulerBody(budget);
        } else {
            return this.generateWorkerBody(budget);
        }
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

    generateHaulerBody: function(budget) {
        // CARRY, MOVE (100)
        let body = [];
        let cost = 0;
        
        while (cost + 100 <= budget && body.length + 2 <= 50) {
            body.push(CARRY);
            body.push(MOVE);
            cost += 100;
        }
        
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

    sortBody: function(body) {
        const sortOrder = { [TOUGH]: 0, [WORK]: 1, [CARRY]: 2, [MOVE]: 3 };
        return body.sort((a, b) => sortOrder[a] - sortOrder[b]);
    },

    calculateBodyCost: function(body) {
        return body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
    }
};

module.exports = managerSpawner;