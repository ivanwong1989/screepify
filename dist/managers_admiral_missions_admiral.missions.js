/**
 * Admiral Missions: generate combat missions and compositions.
 */
var admiralMissions = {
    generate: function(room, hostiles, threat, state, budget) {
        const missions = [];
        const cache = global.getRoomCache(room);

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
                census: { count: 0, workParts: 0, carryParts: 0 }
            });
        }

        // Maintenance Missions (Fortify walls/ramparts)
        const structures = [
            ...(cache.myStructuresByType[STRUCTURE_RAMPART] || []),
            ...(cache.myStructuresByType[STRUCTURE_WALL] || [])
        ];
        const weakWalls = structures.filter(s => s.hits < 5000);
        if (weakWalls.length > 0) {
            missions.push({
                name: `fortify_${room.name}_walls`,
                type: 'repair',
                archetype: 'worker',
                priority: 40,
                requirements: { count: 1 },
                targetIds: weakWalls.map(w => w.id),
                census: { count: 0, workParts: 0, carryParts: 0 }
            });
        }

        // Patrol Mission
        // Ensure idle defenders have a mission so they don't drift or get confused
        const defenderCount = (cache.myCreeps || []).filter(c => 
            ['defender', 'brawler'].includes(c.memory.role)
        ).length;

        if (defenderCount > 0) {
            missions.push({
                name: `patrol_${room.name}_perimeter`,
                type: 'patrol',
                archetype: 'defender',
                priority: 10,
                requirements: { count: defenderCount, spawn: false },
                data: { },
                census: { count: 0, workParts: 0, carryParts: 0 }
            });
        }

        return missions;
    },

    /**
     * Tactical Spawning: Uses weighted threat and EHP to determine composition.
     */
    calculateResponse: function(threat, budget, room) {
        const cache = global.getRoomCache(room);
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
        const defenders = (cache.myCreeps || []).filter(c => 
            c.memory.role === archetype && c.memory.missionName && c.memory.missionName.startsWith(`defend_${room.name}`)
        );
        
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

module.exports = admiralMissions;
