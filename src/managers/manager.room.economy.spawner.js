// Helper to calculate body cost
const getBodyCost = (body) => body.reduce((cost, part) => cost + BODYPART_COST[part], 0);

// Helper to select the best body tier based on a budget
const getTieredBody = function(budget, tiers) {
    let bestBody = tiers[0];
    for (let i = 0; i < tiers.length; i++) {
        let body = tiers[i];
        let cost = getBodyCost(body);
        if (cost <= budget) {
            bestBody = body;
        } else {
            break;
        }
    }
    return bestBody;
};

module.exports = {
    /**
     * The Spawner Manager reads the Overseer's State and calculates the required workforce.
     * It then checks the census and spawns creeps to meet the quotas.
     * 
     * @param {Room} room
     */
    run: function(room) {
        if (!room.memory.brain) return;
        const brain = room.memory.brain;
        const state = brain.state;
        const currentCounts = brain.counts || {};

        // 1. Determine Quotas based on State
        const quotas = this.getQuotas(room, state);

        // 2. Check for Deficits
        let spawnRequest = null;
        
        // Priority Order
        const priority = ['harvester', 'harvester_big', 'hauler', 'defender', 'upgrader', 'builder'];
        
        for (let role of priority) {
            const current = (currentCounts[role] || 0);
            const target = (quotas[role] || 0);
            if (current < target) {
                spawnRequest = role;
                break;
            }
        }

        // 3. Execute Spawn
        if (spawnRequest) {
            const spawn = room.find(FIND_MY_SPAWNS).filter(s => !s.spawning)[0];
            if (spawn) {
                this.executeSpawn(spawn, spawnRequest, room, state);
            }
        }
    },

    getQuotas: function(room, state) {
        const quotas = {
            harvester_big: 0,
            harvester: 0,
            hauler: 0,
            upgrader: 0,
            builder: 0,
            defender: 0
        };

        const numSources = room.find(FIND_SOURCES).length;

        if (state === 'EMERGENCY') {
            quotas.harvester = 2;
            quotas.hauler = 1;
        } else {
            quotas.harvester_big = numSources;
            quotas.hauler = numSources + 1; // Base baseline
            quotas.upgrader = 1;

            if (state === 'GROWTH') {
                quotas.builder = 2;
            } else if (state === 'DEFENSE') {
                quotas.defender = 2;
                quotas.upgrader = 0; // Divert energy to defense
            } else if (state === 'STABLE') {
                if (room.storage && room.storage.store[RESOURCE_ENERGY] > 100000) {
                    quotas.upgrader = 2;
                }
            }
        }
        return quotas;
    },

    executeSpawn: function(spawn, role, room, state) {
        // Body Definitions
        const tiers = this.getBodyTiers(role);
        const budget = state === 'EMERGENCY' ? Math.max(room.energyAvailable, 300) : room.energyCapacityAvailable;
        const body = getTieredBody(budget, tiers);
        
        const name = `${role}_${Game.time}`;
        const memory = { role: role, room: room.name };
        
        const result = spawn.spawnCreep(body, name, { memory: memory });
        if (result === OK) {
            console.log(`[Spawner] Spawning ${name} (${state})`);
        }
    },

    getBodyTiers: function(role) {
        // Simplified tier definitions for the example
        if (role === 'harvester_big') return [
            [WORK, WORK, CARRY, MOVE],
            [WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE],
            [WORK, WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE]
        ];
        if (role === 'hauler') return [
            [CARRY, MOVE],
            [CARRY, CARRY, MOVE, MOVE],
            [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE]
        ];
        if (role === 'upgrader' || role === 'builder') return [
            [WORK, CARRY, MOVE],
            [WORK, WORK, CARRY, CARRY, MOVE, MOVE]
        ];
        if (role === 'defender') return [
            [TOUGH, ATTACK, MOVE],
            [TOUGH, TOUGH, ATTACK, ATTACK, MOVE, MOVE]
        ];
        // Fallback/Bootstrap harvester
        return [[WORK, CARRY, MOVE]];
    }
};
