/**
 * Enhanced Military Tasker for Admiral Missions
 */
var militaryTasks = {
    run: function(room) {
        const allMissions = room._missions || [];
        const missions = allMissions.filter(m => m.type === 'defend');
        const defenders = room.find(FIND_MY_CREEPS, {
            filter: c => c.memory.role === 'defender' || c.memory.role === 'brawler'
        });

        const hostiles = room.find(FIND_HOSTILE_CREEPS);
        if (hostiles.length === 0) {
            this.cleanupMissions(defenders, allMissions);
            return;
        }

        missions.forEach(mission => {
            let assigned = defenders.filter(c => c.memory.missionName === mission.name);
            
            // 1. Assignment Logic
            const needed = (mission.requirements.count || 0) - assigned.length;
            if (needed > 0) {
                const idleDefenders = defenders.filter(c => (!c.memory.missionName || c.memory.missionName.includes('decongest')) && !c.spawning);
                for (let i = 0; i < needed && i < idleDefenders.length; i++) {
                    const idle = idleDefenders[i];
                    idle.memory.missionName = mission.name;
                    idle.say('🛡️');
                    assigned.push(idle);
                }
            }

            if (mission.census) mission.census.count = assigned.length;

            // 2. Tactical Execution
            const primaryTarget = this.selectPrimaryTarget(hostiles);
            assigned.forEach(creep => {
                if (!creep.spawning) {
                    this.executeTactics(creep, hostiles, assigned, room, primaryTarget);
                }
            });
        });
    },

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

        for (let y = 0; y < 50; y++) {
            for (let x = 0; x < 50; x++) {
                // Penalty for edges to keep kiters in open space
                if (x <= 1 || x >= 48 || y <= 1 || y >= 48) {
                    costs.set(x, y, 10); 
                }
            }
        }

        // Mark all creeps as impassable obstacles
        room.find(FIND_CREEPS).forEach(c => costs.set(c.pos.x, c.pos.y, 0xff));
        room.find(FIND_STRUCTURES, { 
            filter: s => s.structureType !== STRUCTURE_CONTAINER && 
                         s.structureType !== STRUCTURE_ROAD && 
                         s.structureType !== STRUCTURE_RAMPART // Added rampart check
        }).forEach(s => costs.set(s.pos.x, s.pos.y, 0xff));

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

        let action = null;
        let targetId = null;
        let moveTarget = null;

        // --- 1. ACTION LOGIC ---
        // Prioritize Healing but still allow movement/targeting
        if (hasHeal && creep.hits < creep.hitsMax) {
            action = 'heal';
            targetId = creep.id;
        } else if (hasRanged && range <= 3) {
            action = 'rangedAttack';
            targetId = target.id;
        } else if (!hasRanged && range <= 1) {
            action = 'attack';
            targetId = target.id;
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
            action, 
            targetId, 
            moveTarget: moveTarget ? { x: moveTarget.x, y: moveTarget.y, roomName: moveTarget.roomName || room.name } : null 
        };
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

module.exports = militaryTasks;