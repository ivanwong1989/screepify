/**
 * The Admiral is the military counterpart to the Overseer.
 * It monitors threats and manages combat missions.
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
            const isDangerous = threat.attack > 0 || threat.ranged > 0 || threat.work > 0;
            state = isDangerous ? 'DEFEND' : 'CAUTION';
        }

        // 3. Generate Missions
        const missions = [];

        if (state === 'DEFEND') {
            const response = this.calculateResponse(threat, budget, room);
            missions.push({
                name: `defend_${room.name}`,
                type: 'defend',
                archetype: response.archetype,
                priority: 95, // Very high priority
                requirements: { 
                    count: response.count,
                    body: response.bodyPattern 
                },
                data: { 
                    targetIds: hostiles.map(h => h.id),
                    strategy: response.strategy
                },
                census: { count: 0 }
            });
        }

        // 4. Maintenance Missions (e.g., keeping ramparts up)
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

        // 5. Publish to the shared mission pool
        // We append to existing missions created by Overseer
        if (!room._missions) room._missions = [];
        room._missions = room._missions.concat(missions);
        
        room._combatState = state;
        room.memory.admiral.state = state;

        if (Memory.debug && state !== 'PEACE' && missions.length > 0) {
            const m = missions[0];
            log(`[Admiral] Room ${room.name} state: ${state}, Strategy: ${m.data.strategy}, Req: ${m.requirements.count}x ${m.archetype}`);
        }
    },

    /**
     * Detailed breakdown of enemy body parts to understand their composition.
     */
    analyzeThreat: function(hostiles) {
        const stats = { attack: 0, ranged: 0, heal: 0, tough: 0, work: 0, move: 0, count: hostiles.length };
        hostiles.forEach(c => {
            stats.attack += c.getActiveBodyparts(ATTACK);
            stats.ranged += c.getActiveBodyparts(RANGED_ATTACK);
            stats.heal += c.getActiveBodyparts(HEAL);
            stats.tough += c.getActiveBodyparts(TOUGH);
            stats.work += c.getActiveBodyparts(WORK);
            stats.move += c.getActiveBodyparts(MOVE);
        });
        return stats;
    },

    /**
     * Tactical decision making: what to build and how many, based on threat vs budget.
     */
    calculateResponse: function(threat, budget, room) {
        let archetype = 'defender';
        let strategy = 'BALANCED';
        let bodyPattern = [RANGED_ATTACK, MOVE, HEAL]; // Default segment (450)

        const isMeleeHeavy = threat.attack > threat.ranged * 1.5;
        const isHealHeavy = threat.heal > (threat.attack + threat.ranged);
        const isFast = threat.move >= (threat.attack + threat.ranged + threat.heal + threat.tough + threat.work);

        // 1. Strategy Selection
        if (isHealHeavy) {
            // Need high burst to overcome healing. Melee brawlers have higher DPS per energy.
            strategy = 'BURST_FOCUS';
            bodyPattern = [ATTACK, ATTACK, MOVE]; // 210 cost, 60 dmg
            archetype = 'brawler';
        } else if (isMeleeHeavy && !isFast) {
            // Kite slow melee enemies with pure ranged.
            strategy = 'KITE';
            bodyPattern = [RANGED_ATTACK, MOVE]; // 200 cost, 10 dmg
            archetype = 'defender';
        } else if (isFast && !isMeleeHeavy) {
            // Fast harassers. Need sustain and ranged to trade.
            strategy = 'INTERCEPT';
            bodyPattern = [RANGED_ATTACK, MOVE, MOVE, HEAL]; // 500 cost
            archetype = 'defender';
        }

        // 2. Budget Analysis & Count Calculation
        const patternCost = bodyPattern.reduce((sum, part) => sum + BODYPART_COST[part], 0);
        const segmentsPerCreep = Math.floor(budget / patternCost);
        
        const enemyHealPower = threat.heal * 12;
        const ourDmgPerSegment = bodyPattern.includes(ATTACK) ? 30 : 10;
        
        // Aim for 2x enemy heal power in damage to ensure kills
        const requiredSegments = Math.ceil((enemyHealPower * 2) / ourDmgPerSegment) || 1;
        let count = Math.ceil(requiredSegments / Math.max(1, segmentsPerCreep));

        // Scaling & Safety: Don't get outnumbered, and use duos for mutual healing if threat is real.
        count = Math.max(count, Math.ceil(threat.count / 1.5));
        if (threat.attack > 10 || threat.ranged > 10) count = Math.max(count, 2);
        
        return {
            count: Math.min(count, 4), // Cap to prevent economic collapse
            archetype,
            strategy,
            bodyPattern
        };
    }
};

module.exports = managerAdmiral;
