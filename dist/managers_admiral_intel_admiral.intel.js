/**
 * Admiral Intel: threat analysis and combat state evaluation.
 */
var admiralIntel = {
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

    estimateTowerDamage: function(room, assumedRange) {
        if (!room) return { dps: 0, towers: 0 };
        const cache = global.getRoomCache(room);
        const towers = cache.myStructuresByType[STRUCTURE_TOWER] || [];
        if (towers.length === 0) return { dps: 0, towers: 0 };

        const range = Math.max(1, Math.min(assumedRange || 20, 50));
        let perTower = 600;
        if (range > 5) {
            perTower = 600 - ((range - 5) * 30);
        }
        if (range >= 20) perTower = 150;

        let activeTowers = 0;
        let dps = 0;
        for (const tower of towers) {
            if (!tower.store || tower.store[RESOURCE_ENERGY] < 10) continue;
            activeTowers++;
            dps += perTower;
        }

        return { dps, towers: activeTowers };
    },

    /**
     * Combat State: PEACE, CAUTION, DEFEND, or SIEGE.
     */
    determineCombatState: function(hostiles, threat, room) {
        let state = 'PEACE';
        if (hostiles.length > 0) {
            /* A "Dangerous" threat is any creep with offensive parts or high EHP/work power,
             * AND also unable to be dealt with just our tower damage output.
             * Towers also have fall off damage. Let's make an assumption along the mid point where
             * our towers would mostly likely engage when they are nearer to our base/core. Perhaps 
             * a range of 20 squares perhaps. 
             * We only need to be in a DEFEND state if towers can't outheal or outkill the enemy before 
             * the enemy breaches our ramparts. Othewise, it's CAUTION. 
            */
            const baseDanger = threat.attack > 0 || threat.ranged > 0 || threat.work > 10 || threat.ehp > 2000;
            const towerStats = this.estimateTowerDamage(room, 20);
            const enemyHeal = threat.heal * 12;
            const netTowerDps = towerStats.dps - enemyHeal;
            const timeToKill = netTowerDps > 0 ? (threat.ehp / netTowerDps) : Infinity;
            const towersCanHandle = towerStats.dps > 0 && netTowerDps > 0 && timeToKill <= 20;
            const isDangerous = baseDanger && !towersCanHandle;

            // Trigger SIEGE state if enemy work parts are high (structure destruction threat)
            if (threat.work > 20 && !towersCanHandle) {
                state = 'SIEGE';
            } else {
                state = isDangerous ? 'DEFEND' : 'CAUTION';
            }
        }
        return state;
    }
};

module.exports = admiralIntel;
