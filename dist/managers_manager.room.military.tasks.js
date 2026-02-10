/**
 * Handles combat-specific logic for creeps assigned to Admiral missions.
 */
var militaryTasks = {
    run: function(room) {
        const missions = (room._missions || []).filter(m => m.type === 'defend');
        const defenders = room.find(FIND_MY_CREEPS, {
            filter: c => c.memory.role === 'defender' || c.memory.role === 'brawler'
        });

        const hostiles = room.find(FIND_HOSTILE_CREEPS);

        missions.forEach(mission => {
            let assigned = defenders.filter(c => c.memory.missionName === mission.name);
            
            // 1. Assign Idle Defenders to this mission (Do this BEFORE census)
            const needed = (mission.requirements.count || 0) - assigned.length;
            if (needed > 0) {
                const idleDefenders = defenders.filter(c => !c.memory.missionName && !c.spawning);
                for (let i = 0; i < needed && i < idleDefenders.length; i++) {
                    const idle = idleDefenders[i];
                    idle.memory.missionName = mission.name;
                    idle.say('🛡️');
                    assigned.push(idle); // Add to local list so census is accurate
                }
            }

            // 2. Update Census (The "Contract" for the Spawner)
            if (mission.census) {
                mission.census.count = assigned.length;
            }

            // 2.5 Identify a Primary Target for the whole mission to Focus Fire
            const primaryTarget = this.selectPrimaryTarget(hostiles);

            // 3. Tactical Brain: Execute tactics for each assigned creep (if not spawning)
            assigned.forEach(creep => {
                if (!creep.spawning) {
                    this.executeTactics(creep, hostiles, assigned, room, primaryTarget);
                }
            });
        });

        // Cleanup: Release creeps from finished missions
        defenders.forEach(creep => {
            if (creep.memory.missionName && !missions.find(m => m.name === creep.memory.missionName)) {
                delete creep.memory.missionName;
                delete creep.memory.task;
            }
        });
    },

    /**
     * Selects the highest priority target for the entire squad.
     */
    selectPrimaryTarget: function(hostiles) {
        if (!hostiles || hostiles.length === 0) return null;

        // Priority: Healers > Attackers > Lowest HP
        const healers = hostiles.filter(h => h.getActiveBodyparts(HEAL) > 0);
        if (healers.length > 0) return healers.sort((a, b) => a.hits - b.hits)[0];

        const attackers = hostiles.filter(h => h.getActiveBodyparts(ATTACK) > 0 || h.getActiveBodyparts(RANGED_ATTACK) > 0);
        if (attackers.length > 0) return attackers.sort((a, b) => a.hits - b.hits)[0];

        return hostiles.sort((a, b) => a.hits - b.hits)[0];
    },

    /**
     * Centralized tactical decision making. 
     * This is the "Brain" that sees the whole battlefield.
     */
    executeTactics: function(creep, hostiles, defenders, room, primaryTarget) {
        // 1. Target Selection
        // Use the squad's primary target if available, otherwise fallback to closest
        let target = primaryTarget;

        if (!target) target = creep.pos.findClosestByRange(hostiles);

        if (!target) {
            delete creep.memory.task;
            return;
        }

        const range = creep.pos.getRangeTo(target);
        const hasRanged = creep.getActiveBodyparts(RANGED_ATTACK) > 0;
        const hasMelee = creep.getActiveBodyparts(ATTACK) > 0;
        const hasHeal = creep.getActiveBodyparts(HEAL) > 0;

        let action = null;
        let targetId = null;
        let moveTarget = null;

        // 2. Tactical Analysis: Check health and potential threats
        const isDamaged = creep.hits < creep.hitsMax * 0.9;

        let healTarget = null;
        if (hasHeal) {
            if (isDamaged) {
                healTarget = creep;
            } else {
                // Look for damaged allies nearby to support "duo" behavior
                const needyAlly = creep.pos.findInRange(defenders, 3, {
                    filter: d => d.hits < d.hitsMax
                })[0];
                if (needyAlly) healTarget = needyAlly;
            }
        }

        // 3. Decision Logic
        if (healTarget) {
            action = creep.pos.isNearTo(healTarget) ? 'heal' : 'rangedHeal';
            targetId = healTarget.id;
            // Retreat while healing
            const fleePath = PathFinder.search(creep.pos, { pos: target.pos, range: 5 }, { flee: true }).path;
            if (fleePath.length > 0) {
                moveTarget = { x: fleePath[0].x, y: fleePath[0].y, roomName: fleePath[0].roomName };
            }
        } else {
            if (hasRanged) {
                if (range <= 3) {
                    action = 'rangedAttack';
                    targetId = target.id;
                }
                // Kiting: Maintain range 3
                if (range < 3) {
                    const fleePath = PathFinder.search(creep.pos, { pos: target.pos, range: 4 }, { flee: true }).path;
                    if (fleePath.length > 0) {
                        moveTarget = { x: fleePath[0].x, y: fleePath[0].y, roomName: fleePath[0].roomName };
                    }
                } else if (range > 3) {
                    moveTarget = { x: target.pos.x, y: target.pos.y, roomName: target.pos.roomName };
                }
            } else if (hasMelee) {
                if (range <= 1) {
                    action = 'attack';
                    targetId = target.id;
                }
                moveTarget = { x: target.pos.x, y: target.pos.y, roomName: target.pos.roomName };
            }
        }

        // 4. Assign Task to Creep
        creep.memory.task = { action, targetId, moveTarget };
    }
};

module.exports = militaryTasks;
