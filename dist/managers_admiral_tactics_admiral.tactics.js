/**
 * Admiral Tactics: per-creep combat execution helpers.
 */
var admiralTactics = {
    selectPrimaryTarget: function(hostiles) {
        if (!hostiles.length) return null;
        // Priority: Healers > Ranged > Melee > Lowest HP
        const healers = hostiles.filter(h => h.getActiveBodyparts(HEAL) > 0);
        if (healers.length > 0) return healers.sort((a, b) => a.hits - b.hits)[0];

        const threats = hostiles.filter(h => h.getActiveBodyparts(ATTACK) > 0 || h.getActiveBodyparts(RANGED_ATTACK) > 0);
        if (threats.length > 0) return threats.sort((a, b) => a.hits - b.hits)[0];

        return hostiles.sort((a, b) => a.hits - b.hits)[0];
    },

    getTacticalMatrix: function(room, hostiles) {
        let costs = new PathFinder.CostMatrix();
        const terrain = room.getTerrain();
        const cache = global.getRoomCache(room);

        for (let y = 0; y < 50; y++) {
            for (let x = 0; x < 50; x++) {
                // Penalty for edges to keep kiters in open space
                if (x <= 1 || x >= 48 || y <= 1 || y >= 48) {
                    costs.set(x, y, 10); 
                }
            }
        }

        // Mark all creeps as impassable obstacles
        (cache.creeps || []).forEach(c => costs.set(c.pos.x, c.pos.y, 0xff));
        (cache.structures || []).filter(s => 
            s.structureType !== STRUCTURE_CONTAINER && 
            s.structureType !== STRUCTURE_ROAD && 
            s.structureType !== STRUCTURE_RAMPART // Added rampart check
        ).forEach(s => costs.set(s.pos.x, s.pos.y, 0xff));

        return costs;
    },

    executeTactics: function(creep, hostiles, defenders, room, primaryTarget) {
        const mission = (room._missions || []).find(m => m.name === creep.memory.missionName);
        if (!mission) return;
        const strategy = (mission.data && mission.data.strategy) || 'BALANCED';
        
        let target = primaryTarget || creep.pos.findClosestByRange(hostiles);
        if (!target) return;

        const range = creep.pos.getRangeTo(target);
        const hasRanged = creep.getActiveBodyparts(RANGED_ATTACK) > 0;
        const hasHeal = creep.getActiveBodyparts(HEAL) > 0;
        const isDangerous = target.getActiveBodyparts(ATTACK) > 0 || target.getActiveBodyparts(RANGED_ATTACK) > 0;

        let moveTarget = null;
        const actions = [];

        // --- 1. ACTION LOGIC ---
        // Pre-healing: Always heal self if capable (mitigates incoming damage in same tick)
        if (hasHeal) {
            actions.push({ action: 'heal', targetId: creep.id });
        }

        // Ranged Attack: Can be done simultaneously with Heal
        if (hasRanged && range <= 3) {
            actions.push({ action: 'rangedAttack', targetId: target.id });
        } 
        // Melee Attack: Mutually exclusive with Melee Heal
        else if (!hasRanged && range <= 1) {
            const healAction = actions.find(a => a.action === 'heal');
            // If we are healthy enough, trade the pre-heal for a melee attack
            if (healAction && creep.hits > creep.hitsMax * 0.5) {
                const idx = actions.indexOf(healAction);
                actions.splice(idx, 1);
                actions.push({ action: 'attack', targetId: target.id });
            } else if (!healAction) {
                actions.push({ action: 'attack', targetId: target.id });
            }
        }

        // --- 2. MOVEMENT LOGIC ---
        if (strategy === 'KITE' && hasRanged) {
            // Only flee if the target is actually a threat. 
            // If they are a pacifist (worker/scout), we close in to Range 3 to kill them.
            if (isDangerous && range < 3) {
                const fleeResult = PathFinder.search(creep.pos, { pos: target.pos, range: 4 }, { 
                    flee: true, 
                    maxRooms: 1,
                    roomCallback: (rn) => this.getTacticalMatrix(Game.rooms[rn] || room, hostiles)
                });
                if (fleeResult.path.length > 0) moveTarget = fleeResult.path[0];
            } else if (range > 3) {
                const path = PathFinder.search(creep.pos, { pos: target.pos, range: 3 }, {
                    maxRooms: 1,
                    roomCallback: (rn) => this.getTacticalMatrix(Game.rooms[rn] || room, hostiles)
                });
                if (path.path.length > 0) moveTarget = path.path[0];
            }
            // Note: If range === 3 and isDangerous, moveTarget is null (Hold ground)
        } else {
            // Default: Approach target directly
            moveTarget = target.pos;
        }

        // --- 3. COMMIT ---
        // Ensure moveTarget is serialized safely for memory
        creep.memory.task = { 
            actions,
            moveTarget: moveTarget ? { x: moveTarget.x, y: moveTarget.y, roomName: moveTarget.roomName || room.name } : null 
        };
    },

    executePatrol: function(creep, squad, room) {
        // 1. Self Sustain
        if (creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0) {
            creep.heal(creep);
            return; // Action consumed
        }

        // 2. Seek Healer
        if (creep.hits < creep.hitsMax) {
            const healer = squad.find(c => c.getActiveBodyparts(HEAL) > 0);
            if (healer) {
                creep.moveTo(healer);
                creep.say('ðŸš‘');
                return;
            }
        }

        // 3. Provide Support (If Healer)
        if (creep.getActiveBodyparts(HEAL) > 0) {
            const wounded = squad.find(c => c.hits < c.hitsMax);
            if (wounded) {
                if (creep.pos.isNearTo(wounded)) {
                    creep.heal(wounded);
                } else {
                    creep.moveTo(wounded);
                    creep.rangedHeal(wounded);
                }
                return;
            }
        }

        // 4. Patrol / Park
        // Park near spawn or controller to avoid blocking sources
        const cache = global.getRoomCache(room);
        const anchor = (cache.myStructuresByType[STRUCTURE_SPAWN] || [])[0] || room.controller;
        if (anchor && !creep.pos.inRangeTo(anchor, 5)) {
            creep.moveTo(anchor, { range: 5 });
        }
    },

    cleanupMissions: function(defenders, allMissions) {
        defenders.forEach(creep => {
            if (creep.memory.missionName && !allMissions.find(m => m.name === creep.memory.missionName)) {
                delete creep.memory.missionName;
                delete creep.memory.task;
            }
        });
    }
};

module.exports = admiralTactics;
