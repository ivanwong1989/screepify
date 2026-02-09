/**
 * The Task Manager reads the Overseer's demands and missions.
 * With the known mission types, it is able to break it down to small tasks that it can
 * track for the room. These small tasks for example are harvest, pickup, upgrade, repair, moveto, transfer, repair.
 * Combat related tasks should not be in this economy.tasks. This tasker should wholly focus on room economy and
 * day to day menial missions that are composed of tasks.
 * It then assigns these missions to available creeps. The creeps are not locked into roles. Tasker is able to 
 * know from the room, what creep and body parts are there, are the creeps idle, is it doing work. Tasker is able to 
 * freely decide which idle creep to take the tasks, which chained together would complete the mission assigned by overseer. 
 * It needs to decide which creep would be best suited for the task at hand, and also availability. 
 * Tasker would read the contract from overseer and handle the missions accordingly. Missions need to persist over multiple ticks
 * as it's individual tasks may only be complete over multiple ticks. 
 * 
 * @param {Room} room
 */
var managerTasks = {
    run: function(room) {
        // 1. Read the Contract (Missions)
        // If no missions are published by Overseer, we have nothing to direct.
        
        // Initialize reservation table for this tick to prevent multiple creeps from targeting the same limited resource
        room._reservedEnergy = {};
        
        if (!room._missions) return;
        
        const missions = room._missions;
        const creeps = room.find(FIND_MY_CREEPS);

        // 2. Track Mission Assignments
        // We need to know how many resources (creeps/parts) are currently assigned to each mission
        // to decide if we need to assign more.
        const missionStatus = {};
        missions.forEach(m => {
            missionStatus[m.name] = {
                mission: m,
                assignedCount: 0,
                assignedWork: 0,
                assignedCarry: 0
            };
        });

        // 3. Validate and Count Existing Assignments
        creeps.forEach(creep => {
            // We count spawning creeps to prevent overcrowding (double assignment)
            if (creep.spawning) return;

            // Check if creep has a mission
            const missionName = creep.memory.missionName;
            if (missionName) {
                // Check if mission still exists in the contract
                if (missionStatus[missionName]) {
                    // Update status
                    missionStatus[missionName].assignedCount++;
                    missionStatus[missionName].assignedWork += creep.getActiveBodyparts(WORK);
                    missionStatus[missionName].assignedCarry += creep.getActiveBodyparts(CARRY);
                } else {
                    // Mission was removed by Overseer (completed or strategy changed)
                    // Release the creep
                    delete creep.memory.missionName;
                    delete creep.memory.taskState;
                    creep.say('?');
                }
            }
        });

        // 4. Assign Idle Creeps
        const idleCreeps = creeps.filter(c => !c.spawning && !c.memory.missionName);
        
        idleCreeps.forEach(creep => {
            const bestMission = this.findBestMission(creep, missions, missionStatus);
            if (bestMission) {
                creep.memory.missionName = bestMission.name;
                creep.memory.taskState = 'init'; // Initialize state
                
                // Update status immediately so next creep in this loop sees updated counts
                missionStatus[bestMission.name].assignedCount++;
                missionStatus[bestMission.name].assignedWork += creep.getActiveBodyparts(WORK);
                missionStatus[bestMission.name].assignedCarry += creep.getActiveBodyparts(CARRY);
                
                creep.say(bestMission.type);
            }
        });

        // Sync Tasker's real-time census back to the mission object for the Spawner
        // This prevents the Spawner from queuing creeps for missions we just filled with idle creeps
        for (const name in missionStatus) {
            const status = missionStatus[name];
            if (status.mission.census) {
                status.mission.census.count = status.assignedCount;
                status.mission.census.workParts = status.assignedWork;
                status.mission.census.carryParts = status.assignedCarry;
            }
        }

        // 5. Assign Actions
        creeps.forEach(creep => {
            if (!creep.spawning && creep.memory.missionName) {
                const status = missionStatus[creep.memory.missionName];
                if (status) {
                    this.assignAction(creep, status.mission, room);
                }
            }
        });

        // 6. Assign Towers
        room._towerTasks = {}; // Initialize ephemeral task list for this tick
        const towers = room.find(FIND_MY_STRUCTURES, { filter: { structureType: STRUCTURE_TOWER } });
        towers.forEach(tower => {
            const bestMission = this.findBestTowerMission(tower, missions);
            if (bestMission) {
                this.assignTowerAction(tower, bestMission, room);
            }
        });
    },

    /**
     * Finds the most suitable mission for a creep based on priority and requirements.
     */
    findBestMission: function(creep, missions, missionStatus) {
        // Filter missions that are not fully staffed
        const candidates = missions.filter(m => {
            // Exclude tower missions
            if (m.type.startsWith('tower')) return false;

            const status = missionStatus[m.name];
            const req = m.requirements || {};

            // Check if requirements are met (Saturation check)
            if (req.count && status.assignedCount >= req.count) return false;

            // Check if creep is capable for this mission type
            if (m.type === 'harvest') {
                if (creep.getActiveBodyparts(WORK) === 0) return false;
            } else if (m.type === 'upgrade' || m.type === 'build') {
                if (creep.getActiveBodyparts(WORK) === 0 || creep.getActiveBodyparts(CARRY) === 0) return false;
            } else if (m.type === 'transfer') {
                if (creep.getActiveBodyparts(CARRY) === 0) return false;
            }

            return true;
        });

        // Sort by Priority (High to Low)
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => b.priority - a.priority);

        return candidates[0];
    },

    findBestTowerMission: function(tower, missions) {
        const candidates = missions.filter(m => {
            if (m.type === 'tower_attack' || m.type === 'tower_heal' || m.type === 'tower_repair') return true;
            return false;
        });
        candidates.sort((a, b) => b.priority - a.priority);
        return candidates[0];
    },

    assignAction: function(creep, mission, room) {
        let task = null;
        switch (mission.type) {
            case 'harvest':
                task = this.getHarvestTask(creep, mission);
                break;
            case 'transfer':
                task = this.getTransferTask(creep, mission, room);
                break;
            case 'upgrade':
                task = this.getUpgradeTask(creep, mission, room);
                break;
            case 'build':
                task = this.getBuildTask(creep, mission, room);
                break;
        }

        if (task) {
            creep.memory.task = task;
        } else {
            delete creep.memory.task;
        }
    },

    assignTowerAction: function(tower, mission, room) {
        let action = null;
        let targetId = null;

        if (mission.type === 'tower_attack') {
            action = 'attack';
            targetId = this.findBestTarget(tower, mission.targetIds);
        } else if (mission.type === 'tower_heal') {
            action = 'heal';
            targetId = this.findBestTarget(tower, mission.targetIds);
        } else if (mission.type === 'tower_repair') {
            action = 'repair';
            targetId = this.findBestTarget(tower, mission.targetIds);
        }

        if (action && targetId) {
            room._towerTasks[tower.id] = { action, targetId };
        }
    },

    findBestTarget: function(tower, targetIds) {
        if (!targetIds || targetIds.length === 0) return null;
        const targets = targetIds.map(id => Game.getObjectById(id)).filter(t => t);
        const target = tower.pos.findClosestByRange(targets);
        return target ? target.id : null;
    },

    // --- Task Generators ---

    getHarvestTask: function(creep, mission) {
        // 1. Static Mining Positioning
        if (mission.data && mission.data.containerId) {
            const container = Game.getObjectById(mission.data.containerId);
            if (container && !creep.pos.isEqualTo(container.pos)) {
                return { action: 'move', targetId: mission.data.containerId };
            }
        }

        // 2. Check Capacity (Mobile Mining / Link Transfer)
        this.updateState(creep);
        if (creep.memory.taskState === 'working' && creep.getActiveBodyparts(CARRY) > 0) {
            const nearby = creep.pos.findInRange(FIND_STRUCTURES, 1, {
                filter: s => (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_LINK)
            });
            
            const transferTarget = nearby.find(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);

            if (transferTarget) {
                return { action: 'transfer', targetId: transferTarget.id, resourceType: RESOURCE_ENERGY };
            }
            
            // If there is a container/link nearby (even if full), we treat it as static mining and drop.
            if (nearby.length > 0 && (!mission.data || mission.data.mode !== 'mobile')) {
                return { action: 'drop', resourceType: RESOURCE_ENERGY };
            }
            
            // If mission is explicitly static (drop mining), do not attempt delivery
            if (mission.data && mission.data.mode === 'static') {
                // Only drop if we are near the source (range 1) to avoid dropping energy 
                // in the middle of nowhere if the mission mode switched while traveling.
                const source = Game.getObjectById(mission.sourceId);
                if (source && creep.pos.inRangeTo(source, 1)) {
                    return { action: 'drop', resourceType: RESOURCE_ENERGY };
                }
            }

            // No container nearby: Mobile Mining behavior. Deliver to Spawn/Extension.
            let deliveryTarget = creep.pos.findClosestByRange(FIND_MY_STRUCTURES, {
                filter: s => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
                             s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
            });

            if (!deliveryTarget) {
                deliveryTarget = creep.pos.findClosestByRange(FIND_MY_STRUCTURES, {
                    filter: s => (s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 50) ||
                                 (s.structureType === STRUCTURE_STORAGE && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0)
                });
            }

            if (deliveryTarget) {
                return { action: 'transfer', targetId: deliveryTarget.id, resourceType: RESOURCE_ENERGY };
            }

            // Fallback to upgrading controller if everything is full
            if (creep.room.controller && creep.room.controller.my) {
                return { action: 'upgrade', targetId: creep.room.controller.id };
            }

            return null;
        }

        // 3. Harvest
        return { action: 'harvest', targetId: mission.sourceId };
    },

    getTransferTask: function(creep, mission, room) {
        this.updateState(creep);
        if (creep.memory.taskState === 'working') {
            let target = null;
            
            if (mission.targetType === 'transfer_list' && mission.data && mission.data.targetIds) {
                const targets = mission.data.targetIds
                    .map(id => Game.getObjectById(id))
                    .filter(t => t && t.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
                target = creep.pos.findClosestByRange(targets);
            }

            if (target) {
                return { action: 'transfer', targetId: target.id, resourceType: RESOURCE_ENERGY };
            }

            // Fallback: If primary targets are full, try Storage, Towers, or any other Refillable
            if (room.storage && room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                return { action: 'transfer', targetId: room.storage.id, resourceType: RESOURCE_ENERGY };
            }

            const cache = global.getRoomCache(room);
            const towers = (cache.structuresByType[STRUCTURE_TOWER] || [])
                .filter(s => s.my && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
            
            if (towers.length > 0) {
                const tower = creep.pos.findClosestByRange(towers);
                if (tower) return { action: 'transfer', targetId: tower.id, resourceType: RESOURCE_ENERGY };
            }

            const refillables = [
                ...(cache.structuresByType[STRUCTURE_SPAWN] || []),
                ...(cache.structuresByType[STRUCTURE_EXTENSION] || [])
            ].filter(s => s.my && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
            
            if (refillables.length > 0) {
                const target = creep.pos.findClosestByRange(refillables);
                if (target) return { action: 'transfer', targetId: target.id, resourceType: RESOURCE_ENERGY };
            }
        } else {
            const excludeIds = (mission.data && mission.data.targetIds) ? mission.data.targetIds : [];
            return this.getGatherTask(creep, room, excludeIds);
        }
        return null;
    },

    getUpgradeTask: function(creep, mission, room) {
        this.updateState(creep);
        if (creep.memory.taskState === 'working') {
            return { action: 'upgrade', targetId: mission.targetId };
        } else {
            return this.getGatherTask(creep, room);
        }
    },

    getBuildTask: function(creep, mission, room) {
        this.updateState(creep);
        if (creep.memory.taskState === 'working') {
            const targets = (mission.targetIds || []).map(id => Game.getObjectById(id)).filter(t => t);
            const target = creep.pos.findClosestByRange(targets);
            if (target) {
                return { action: 'build', targetId: target.id };
            }
        } else {
            return this.getGatherTask(creep, room);
        }
        return null;
    },

    updateState: function(creep) {
        if (creep.memory.taskState !== 'working' && creep.store.getFreeCapacity() === 0) {
            creep.memory.taskState = 'working';
            creep.say('work');
        } else if (creep.memory.taskState !== 'gathering' && creep.store[RESOURCE_ENERGY] === 0) {
            creep.memory.taskState = 'gathering';
            creep.say('gather');
        }
    },

    getGatherTask: function(creep, room, excludeIds = []) {
        // Ensure reservation table exists (safety check)
        if (!room._reservedEnergy) room._reservedEnergy = {};

        // 1. Pickup Dropped
        const dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
            filter: r => {
                if (r.resourceType !== RESOURCE_ENERGY || r.amount <= 50) return false;
                const reserved = room._reservedEnergy[r.id] || 0;
                // Only target if there is enough energy remaining after other creeps take their share
                return (r.amount - reserved) >= 50;
            }
        });
        if (dropped) {
            // Reserve the amount this creep will take (up to its capacity)
            room._reservedEnergy[dropped.id] = (room._reservedEnergy[dropped.id] || 0) + creep.store.getFreeCapacity();
            return { action: 'pickup', targetId: dropped.id };
        }

        // 2. Withdraw from Container/Storage
        const structure = creep.pos.findClosestByRange(FIND_STRUCTURES, {
            filter: s => {
                if (excludeIds.includes(s.id)) return false;
                if ((s.structureType !== STRUCTURE_CONTAINER && s.structureType !== STRUCTURE_STORAGE)) return false;
                const energy = s.store[RESOURCE_ENERGY];
                const reserved = room._reservedEnergy[s.id] || 0;
                return (energy - reserved) >= 50;
            }
        });
        if (structure) {
            room._reservedEnergy[structure.id] = (room._reservedEnergy[structure.id] || 0) + creep.store.getFreeCapacity();
            return { action: 'withdraw', targetId: structure.id, resourceType: RESOURCE_ENERGY };
        }

        // 3. Harvest (if capable)
        if (creep.getActiveBodyparts(WORK) > 0) {
            const source = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
            if (source) {
                return { action: 'harvest', targetId: source.id };
            }
        }
        return null;
    }
};

module.exports = managerTasks;
