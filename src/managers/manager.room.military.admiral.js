/**
 * The Admiral is the military counterpart to the Overseer.
 * It monitors threats and manages combat missions with advanced assessment.
 */
var managerAdmiral = {
    run: function(room) {
        if (!room.memory.admiral) room.memory.admiral = {};

        // 1. Military Intel
        const hostiles = room.find(FIND_HOSTILE_CREEPS);
        const threat = this.analyzeThreat(hostiles);
        const budget = room.energyCapacityAvailable;

        // 2. Determine Combat State
        let state = 'PEACE';
        if (hostiles.length > 0) {
            // A "Dangerous" threat is any creep with offensive parts or high EHP/work power
            const isDangerous = threat.attack > 0 || threat.ranged > 0 || threat.work > 10 || threat.ehp > 2000;
            
            // Trigger SIEGE state if enemy work parts are high (structure destruction threat)
            if (threat.work > 20) {
                state = 'SIEGE';
            } else {
                state = isDangerous ? 'DEFEND' : 'CAUTION';
            }
        }

        // 3. Generate Missions
        const missions = [];

        if (state === 'DEFEND' || state === 'SIEGE' || state === 'CAUTION') {
            const response = this.calculateResponse(threat, budget, room);
            missions.push({
                name: `defend_${room.name}`,
                type: 'defend',
                archetype: response.archetype,
                priority: state === 'SIEGE' ? 99 : (state === 'DEFEND' ? 95 : 80), // Max priority during siege
                requirements: { 
                    count: response.count,
                    body: response.bodyPattern 
                },
                data: { 
                    targetIds: hostiles.map(h => h.id),
                    strategy: response.strategy,
                    formation: response.formation // Specifies if creeps should move as DUO/QUAD
                },
                census: { count: 0 }
            });
        }

        // 4. Maintenance Missions (Fortify walls/ramparts)
        const structures = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_RAMPART || s.structureType === STRUCTURE_WALL
        });
        const weakWalls = structures.filter(s => s.hits < 5000);
        if (weakWalls.length > 0) {
            missions.push({
                name: `fortify_${room.name}`,
                type: 'repair',
                archetype: 'worker',
                priority: 40,
                requirements: { count: 1 },
                targetIds: weakWalls.map(w => w.id),
                census: { count: 0 }
            });
        }

        // 5. Publish to shared mission pool
        if (!room._missions) room._missions = [];
        room._missions = room._missions.concat(missions);
        
        room._combatState = state;
        room.memory.admiral.state = state;

        if (Memory.debug && state !== 'PEACE' && missions.length > 0) {
            const m = missions[0];
            console.log(`[Admiral] Room ${room.name} state: ${state}, Strat: ${m.data.strategy}, Formation: ${m.data.formation}`);
        }
    },

    /**
     * Enhanced Threat Assessment: Breakdown of enemy body parts with Boost Multipliers.
     * T1: 2x, T2: 3x, T3: 4x effectiveness.
     */
    analyzeThreat: function(hostiles) {
        const stats = { 
            attack: 0, ranged: 0, heal: 0, tough: 0, work: 0, move: 0, 
            count: hostiles.length, ehp: 0 
        };

        hostiles.forEach(creep => {
            let creepEHP = creep.hits;
            
            creep.body.forEach(part => {
                if (part.hits > 0) {
                    let multiplier = 1;
                    
                    if (part.boost) {
                        const boost = part.boost;
                        // HEAL, ATTACK, RANGED multipliers
                        if ([HEAL, ATTACK, RANGED_ATTACK].includes(part.type)) {
                            multiplier = boost.includes('X') ? 4 : (boost.includes('2') ? 3 : 2);
                        }
                        // TOUGH damage reduction (GHO2 = 0.5, XGHO2 = 0.3)
                        if (part.type === TOUGH) {
                            const reduction = boost.includes('XGHO2') ? 0.3 : (boost.includes('GHO2') ? 0.5 : 0.7);
                            creepEHP += (100 / reduction) - 100;
                        }
                    }
                    stats[part.type] += (1 * multiplier);
                }
            });
            stats.ehp += creepEHP;
        });
        return stats;
    },

    /**
     * Tactical Spawning: Uses weighted threat and EHP to determine composition.
     */
    calculateResponse: function(threat, budget, room) {
        let archetype = 'defender';
        let strategy = 'BALANCED';
        let bodyPattern = [RANGED_ATTACK, MOVE, HEAL]; 
        let formation = 'SOLO';

        const isMeleeHeavy = threat.attack > threat.ranged * 1.5;
        const isHealHeavy = threat.heal > (threat.attack + threat.ranged);
        const isTanky = threat.ehp > (threat.count * 2000);

        // 1. Strategy & Archetype Selection
        if (isHealHeavy || isTanky) {
            // High EHP/Heal requires melee burst
            strategy = 'BURST_FOCUS';
            bodyPattern = [ATTACK, ATTACK, MOVE]; 
            archetype = 'brawler';
            formation = 'DUO'; // Use pairs to ensure one creep can heal while the other attacks
        } else if (isMeleeHeavy && threat.move <= threat.count * 10) {
            // Kite slow melee enemies
            strategy = 'KITE';
            bodyPattern = [RANGED_ATTACK, MOVE];
            archetype = 'defender';
        }

        // 2. Count Calculation based on Enemy Heal Power
        const patternCost = bodyPattern.reduce((sum, part) => sum + BODYPART_COST[part], 0);
        const segmentsPerCreep = Math.floor(budget / patternCost);
        
        // Enemy heal power (Heal parts * 12 or boosted equivalent)
        const enemyHealPower = threat.heal * 12;
        const ourDmgPerSegment = bodyPattern.includes(ATTACK) ? 30 : 10;
        
        // Aim for 3x enemy heal power to ensure breakthrough
        const requiredSegments = Math.ceil((enemyHealPower * 3) / ourDmgPerSegment) || 1;
        let count = Math.ceil(requiredSegments / Math.max(1, segmentsPerCreep));

        // Use even numbers for DUO formations
        if (formation === 'DUO') count = Math.ceil(count / 2) * 2;

        return {
            count: Math.min(Math.max(count, 1), 6),
            archetype,
            strategy,
            bodyPattern,
            formation
        };
    }
};

module.exports = managerAdmiral;