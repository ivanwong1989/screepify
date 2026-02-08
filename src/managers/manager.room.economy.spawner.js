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

        if (Memory.debug) {
            const reqString = spawnRequests.map(r => `${r.role}(x${r.count}, p:${r.priority})`).join(', ');
            console.log(`[Spawner] Queue: ${reqString}`);
        }

        // 1. Sort requests by priority
        spawnRequests.sort((a, b) => b.priority - a.priority);
        const topRequest = spawnRequests[0];

        // 2. Execute Spawn
        if (topRequest) {
            const spawn = room.find(FIND_MY_SPAWNS).filter(s => !s.spawning)[0];
            if (spawn) {
                this.executeSpawn(spawn, topRequest, room, state);
            }
        }
    },

    executeSpawn: function(spawn, request, room, state) {
        const role = request.role;
        // Body Definitions
        let body = request.body;
        
        // Calculate Budget
        const budget = state === 'EMERGENCY' ? Math.max(room.energyAvailable, 300) : room.energyCapacityAvailable;

        if (!body) {
            if (request.requirements) {
                body = this.generateBody(request.requirements, budget);
            } else {
                const tiers = this.getBodyTiers(role);
                body = getTieredBody(budget, tiers);
            }
        }
        
        // Check Limits set by Overseer
        const brain = room.memory.brain;
        if (brain && brain.limits && brain.census) {
            // Check Creep Cap
            if (brain.census.total >= brain.limits.maxCreeps) {
                console.log(`[Spawner] Denied ${role}: Max Creeps reached (${brain.census.total}/${brain.limits.maxCreeps})`);
                return;
            }
            
            // Check WORK Saturation
            const newWorkParts = body.filter(p => p === WORK).length;
            if (newWorkParts > 0) {
                const currentWork = brain.census.bodyParts[WORK] || 0;
                if (currentWork + newWorkParts > brain.limits.maxWorkParts) {
                    console.log(`[Spawner] Denied ${role}: Max WORK Saturation (${currentWork}/${brain.limits.maxWorkParts})`);
                    return;
                }
            }
        }

        const name = `${role}_${Game.time}`;
        const memory = { role: role, room: room.name };
        
        const result = spawn.spawnCreep(body, name, { memory: memory });
        if (result === OK) {
            console.log(`[Spawner] Spawning ${name} (${state})`);
        }
    },

    generateBody: function(requirements, budget) {
        let totalCost = 0;
        const counts = {};
        
        // 1. Initial Cost Calculation
        for (const part in requirements) {
            const count = requirements[part];
            counts[part] = count;
            totalCost += BODYPART_COST[part] * count;
        }

        // 2. Scale Down if needed
        if (totalCost > budget) {
            const scale = budget / totalCost;
            totalCost = 0; // Recalculate
            for (const part in counts) {
                let count = Math.floor(requirements[part] * scale);
                // Ensure at least 1 if required (soft limit), unless budget is extremely low
                if (count < 1 && requirements[part] > 0) count = 1;
                counts[part] = count;
                totalCost += count * BODYPART_COST[part];
            }
        }

        // 3. Hard Budget Cap (Trim parts if still over due to soft limits)
        // Priority for REMOVAL: CLAIM > ATTACK > RANGED > WORK > CARRY > TOUGH > MOVE
        const removalOrder = [CLAIM, ATTACK, RANGED_ATTACK, WORK, CARRY, TOUGH, MOVE];
        
        while (totalCost > budget) {
            let removed = false;
            for (const part of removalOrder) {
                if (counts[part] > 0) {
                    // Optimization: Prefer removing from types that have > 1 part first
                    if (counts[part] > 1) {
                        counts[part]--;
                        totalCost -= BODYPART_COST[part];
                        removed = true;
                        break;
                    }
                }
            }
            
            if (!removed) {
                // If we couldn't remove any "excess" parts, remove single parts
                for (const part of removalOrder) {
                    if (counts[part] > 0) {
                        counts[part]--;
                        totalCost -= BODYPART_COST[part];
                        removed = true;
                        break;
                    }
                }
            }
            
            if (!removed) break; // Should not happen unless empty
        }

        return this.formatBody(counts);
    },

    formatBody: function(counts) {
        const body = [];
        // Standard spawn order: TOUGH -> WORK -> CARRY -> ATTACK -> MOVE
        const spawnOrder = [TOUGH, WORK, CARRY, ATTACK, RANGED_ATTACK, HEAL, CLAIM, MOVE];
        
        for (const part of spawnOrder) {
            const count = counts[part] || 0;
            for (let i = 0; i < count; i++) {
                body.push(part);
            }
        }
        return body;
    },

    getBodyTiers: function(role) {
        // Simplified tier definitions for the example
        if (role === 'universal') return [
            [WORK, CARRY, MOVE],
            [WORK, WORK, CARRY, CARRY, MOVE, MOVE],
            [WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE]
        ];
        if (role === 'miner') return [
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
        // Fallback/Bootstrap miner
        return [[WORK, CARRY, MOVE]];
    }
};
