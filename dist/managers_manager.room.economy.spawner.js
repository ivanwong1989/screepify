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
        const spawnRequests = brain.spawnRequests || [];

        if (spawnRequests.length === 0) return;

        // 1. Sort requests by priority
        spawnRequests.sort((a, b) => b.priority - a.priority);
        const topRequest = spawnRequests[0];

        // 2. Execute Spawn
        if (topRequest) {
            const spawn = room.find(FIND_MY_SPAWNS).filter(s => !s.spawning)[0];
            if (spawn) {
                this.executeSpawn(spawn, topRequest.role, room, state);
            }
        }
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
        if (role === 'universal') return [
            [WORK, CARRY, MOVE],
            [WORK, WORK, CARRY, CARRY, MOVE, MOVE],
            [WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE]
        ];
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
