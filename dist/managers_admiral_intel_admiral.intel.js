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

    /**
     * Combat State: PEACE, CAUTION, DEFEND, or SIEGE.
     */
    determineCombatState: function(hostiles, threat) {
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
        return state;
    }
};

module.exports = admiralIntel;
