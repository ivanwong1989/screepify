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
                name: `defend_${room.name}_${response.strategy}`,
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
                name: `fortify_${room.name}_walls`,
                type: 'repair',
                archetype: 'worker',
                priority: 40,
                requirements: { count: 1 },
                targetIds: weakWalls.map(w => w.id),
                census: { count: 0 }
            });
        }

        // 5. Patrol Mission
        // Ensure idle defenders have a mission so they don't drift or get confused
        const defenderCount = room.find(FIND_MY_CREEPS, { 
            filter: c => ['defender', 'brawler'].includes(c.memory.role) 
        }).length;

        if (defenderCount > 0) {
            missions.push({
                name: `patrol_${room.name}_perimeter`,
                type: 'patrol',
                archetype: 'defender',
                priority: 10,
                requirements: { count: defenderCount, spawn: false },
                data: { },
                census: { count: 0 }
            });
        }

        // 6. Publish to shared mission pool
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
            attack: 0, ranged: 0, heal: 0, tough: 0, work: 0, move: 0, carry: 0, claim: 0,
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
                    if (stats[part.type] !== undefined) {
                        stats[part.type] += (1 * multiplier);
                    }
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
        
        // 1. Analyze Battlefield Damage & Healing
        const enemyMeleeDmg = threat.attack * 30;
        const enemyRangedDmg = threat.ranged * 10;
        const enemyTotalDmg = enemyMeleeDmg + enemyRangedDmg;
        const enemyHeal = threat.heal * 12;

        // 2. Analyze Mobility (Fatigue check)
        // Sum of all parts that generate fatigue vs MOVE parts that reduce it
        const totalParts = threat.attack + threat.ranged + threat.heal + threat.work + threat.tough + threat.move + threat.carry + threat.claim;
        // 1 MOVE part counteracts fatigue from 2 body parts on plain. 
        const isSlow = threat.move < (totalParts / 2);

        // 3. Strategy Selection

        // KITE: Effective against Melee-heavy enemies that are kiteable (slow or we are faster).
        if (enemyMeleeDmg > enemyRangedDmg * 2 && isSlow) {
            strategy = 'KITE';
            archetype = 'defender';
            // Kiting body: Speed and Range. Self-heal is good for stray hits.
            if (budget >= 500) {
                bodyPattern = [RANGED_ATTACK, MOVE, MOVE, HEAL];
            } else {
                bodyPattern = [RANGED_ATTACK, MOVE];
            }
        }
        // BRAWL (BURST_FOCUS): Enemy has high sustain (Heal) or is very tanky. We need DPS.
        else if (enemyHeal > 100 || threat.ehp > 5000) {
            strategy = 'BURST_FOCUS';
            archetype = 'brawler';
            formation = 'DUO'; // Group up for focus fire
            
            // Brawler Body: Needs to survive closing the gap.
            if (enemyTotalDmg > 150 && budget >= 500) {
                // Paladin: Attack with self-sustain
                bodyPattern = [ATTACK, ATTACK, MOVE, MOVE, HEAL, MOVE];
            } else {
                // Standard Brawler
                bodyPattern = [ATTACK, ATTACK, MOVE, MOVE];
            }
        }
        // SUSTAIN (BALANCED): Default engagement. Trade efficiently.
        else {
            strategy = 'BALANCED';
            archetype = 'defender';
            
            // If enemy deals high damage, prioritize tankiness/healing.
            if (enemyTotalDmg > 150 && budget >= 600) {
                // Tanky Defender
                bodyPattern = [RANGED_ATTACK, MOVE, HEAL, HEAL, MOVE];
            } else {
                // Standard Defender
                bodyPattern = [RANGED_ATTACK, MOVE, HEAL, MOVE];
            }
        }

        // Fallback for very low budget (RCL 1/2)
        if (budget < 300) {
             bodyPattern = [ATTACK, MOVE];
             archetype = 'brawler';
             strategy = 'BALANCED';
        }

        // 4. Count Calculation
        const patternCost = bodyPattern.reduce((sum, part) => sum + BODYPART_COST[part], 0);
        const segmentsPerCreep = Math.floor(budget / patternCost);
        const actualSegments = Math.max(1, Math.min(segmentsPerCreep, Math.floor(50 / bodyPattern.length)));
        
        let myDps = 0;
        let myHps = 0;
        bodyPattern.forEach(p => {
            if (p === ATTACK) myDps += 30;
            if (p === RANGED_ATTACK) myDps += 10;
            if (p === HEAL) myHps += 12;
        });
        myDps *= actualSegments;
        myHps *= actualSegments;
        
        let count = 1;

        if (strategy === 'KITE') {
            // Need enough DPS to overcome enemy heal
            if (myDps > 0) count = Math.ceil((enemyHeal * 1.1) / myDps);
        } else {
            // Need to Out-DPS their Heal OR Out-Heal their Damage
            const countToKill = (myDps > 0) ? Math.ceil((enemyHeal * 1.3) / myDps) : 10;
            const countToSurvive = (myHps > 0) ? Math.ceil((enemyTotalDmg * 1.1) / myHps) : 1;
            
            // If we are brawling (Burst), we prioritize Killing.
            // If we are balancing, we prioritize Surviving.
            if (strategy === 'BURST_FOCUS') {
                count = countToKill;
            } else {
                count = Math.max(countToKill, countToSurvive);
            }
        }

        // Use even numbers for DUO formations
        if (formation === 'DUO') count = Math.ceil(count / 2) * 2;

        // 5. Attrition Compensation
        // If existing defenders are heavily damaged, request reinforcements early.
        const defenders = room.find(FIND_MY_CREEPS, {
            filter: c => c.memory.role === archetype && c.memory.missionName && c.memory.missionName.startsWith(`defend_${room.name}`)
        });
        
        if (defenders.length > 0) {
            const totalHits = defenders.reduce((sum, c) => sum + c.hits, 0);
            const totalMaxHits = defenders.reduce((sum, c) => sum + c.hitsMax, 0);
            
            // If fleet health is below 60%, add a replacement to the queue
            if (totalMaxHits > 0 && (totalHits / totalMaxHits) < 0.6) {
                count += (formation === 'DUO' ? 2 : 1);
            }
        }

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