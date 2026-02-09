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

            if (req.count && current.count < req.count) {
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
                this.spawnCreep(spawns[0], spawnQueue[0], room);
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
        else if (mission.census.count === 0 && room.energyAvailable < budget) {
            budget = Math.max(room.energyAvailable, 100);
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
            } else {
                log(`[Spawner] Failed to spawn ${name}: ${result}`);
            }
        } else {
            log(`[Spawner] Waiting for energy: ${mission.name} (Cost: ${cost}/${room.energyAvailable}) [Budget: ${budget}, State: ${state}]`);
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