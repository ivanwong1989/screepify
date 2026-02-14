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
    getRemoteCreepsByHomeRoom: function() {
        const cache = global._remoteCreepsByHomeRoom;
        if (cache && cache.time === Game.time) return cache.byRoom;

        const byRoom = {};
        const creeps = Object.values(Game.creeps);
        for (const creep of creeps) {
            if (!creep || !creep.my) continue;
            const memory = creep.memory || {};
            const home = memory.room;
            if (!home) continue;
            if (creep.room && creep.room.name === home) continue; // local creeps are handled by room cache

            if (!byRoom[home]) {
                byRoom[home] = { assigned: [], idle: [] };
            }
            if (memory.missionName) byRoom[home].assigned.push(creep);
            else byRoom[home].idle.push(creep);
        }

        global._remoteCreepsByHomeRoom = { time: Game.time, byRoom };
        return byRoom;
    },

    isRemoteMission: function(mission, homeRoomName) {
        if (!mission || !homeRoomName) return false;
        if (mission.type && mission.type.startsWith('remote_')) return true;
        const data = mission.data || {};
        if (data.remoteRoom || data.targetRoom) return true;
        const pos = mission.targetPos || data.targetPos;
        if (pos && pos.roomName && pos.roomName !== homeRoomName) return true;
        return false;
    },

    run: function(room) {
        // 1. Read the Contract (Missions)
        // If no missions are published by Overseer, we have nothing to direct.
        
        // Initialize reservation table for this tick to prevent multiple creeps from targeting the same limited resource
        room._reservedEnergy = {};
        
        if (!room._missions) return;
        
        const missions = room._missions;
        this.buildIdCache(room, missions);
        const missionsSorted = [...missions].sort((a, b) => (b.priority || 0) - (a.priority || 0));
        const cache = global.getRoomCache(room);
        const localCreeps = cache.myCreeps || [];
        // Include creeps spawned by this room that are currently in other rooms,
        // so their missions continue to update (e.g., dismantle in adjacent rooms).
        const remoteByHome = this.getRemoteCreepsByHomeRoom();
        const remote = remoteByHome[room.name] || { assigned: [], idle: [] };
        const creeps = localCreeps.concat(remote.assigned);

        // 2. Track Mission Assignments
        // We need to know how many resources (creeps/parts) are currently assigned to each mission
        // to decide if we need to assign more.
        const missionStatus = {};
        missions.forEach(m => {
            missionStatus[m.name] = {
                mission: m,
                assignedCount: 0,
                assignedWorkParts: 0,
                assignedCarryParts: 0
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
                    const home = creep.memory.room;
                    const awayFromHome = home && creep.room && creep.room.name !== home;
                    if (awayFromHome && !this.isRemoteMission(missionStatus[missionName].mission, home)) {
                        delete creep.memory.missionName;
                        delete creep.memory.taskState;
                        delete creep.memory.scout;
                        delete creep.memory.task;
                        creep.say('home');
                        return;
                    }
                    const req = missionStatus[missionName].mission.requirements;
                    if (req && req.archetype && creep.memory.role !== req.archetype) {
                        delete creep.memory.missionName;
                        delete creep.memory.taskState;
                        delete creep.memory.scout;
                        delete creep.memory.task;
                        creep.say('role');
                        return;
                    }
                    // Update status
                    missionStatus[missionName].assignedCount++;
                    missionStatus[missionName].assignedWorkParts += creep.getActiveBodyparts(WORK);
                    missionStatus[missionName].assignedCarryParts += creep.getActiveBodyparts(CARRY);
                } else {
                    // Mission was removed by Overseer (completed or strategy changed)
                    // Release the creep
                    delete creep.memory.missionName;
                    delete creep.memory.taskState;
                    delete creep.memory.scout;
                    delete creep.memory.task;
                    creep.say('?');
                }
            }
        });

        // 4. Assign Idle Creeps
        const localIdle = localCreeps.filter(c => !c.spawning && !c.memory.missionName);
        const remoteIdle = (remote.idle || []).filter(c => !c.spawning && !c.memory.missionName);
        const idleCreeps = localIdle.concat(remoteIdle);

        // Clear any stale tasks on unassigned creeps so they don't keep acting without a mission
        idleCreeps.forEach(creep => {
            if (creep.memory.task) delete creep.memory.task;
            if (creep.memory.taskState) delete creep.memory.taskState;
        });
        
        idleCreeps.forEach(creep => {
            const bestMission = this.findBestMission(creep, missionsSorted, missionStatus);
            if (bestMission) {
                creep.memory.missionName = bestMission.name;
                creep.memory.taskState = 'init'; // Initialize state
                
                // Update status immediately so next creep in this loop sees updated counts
                missionStatus[bestMission.name].assignedCount++;
                missionStatus[bestMission.name].assignedWorkParts += creep.getActiveBodyparts(WORK);
                missionStatus[bestMission.name].assignedCarryParts += creep.getActiveBodyparts(CARRY);
                
                creep.say(bestMission.type);
            }
        });

        // 4.5 If still idle and away from home, return to home room
        idleCreeps.forEach(creep => {
            if (creep.memory.missionName) return;
            const home = creep.memory.room;
            if (!home || creep.room.name === home) return;

            let targetPos = null;
            const homeRoom = Game.rooms[home];
            if (homeRoom && homeRoom.controller) {
                targetPos = homeRoom.controller.pos;
            } else {
                targetPos = new RoomPosition(25, 25, home);
            }

            creep.memory.task = {
                action: 'move',
                targetPos: { x: targetPos.x, y: targetPos.y, roomName: targetPos.roomName },
                range: 5
            };
        });

        // Sync Tasker's real-time census back to the mission object for the Spawner
        // This prevents the Spawner from queuing creeps for missions we just filled with idle creeps
        for (const name in missionStatus) {
            const status = missionStatus[name];
            // Do not overwrite census for missions that track by role (e.g. fleet), as Tasker only tracks active assignments
            if (status.mission.roleCensus) continue;
            if (status.mission.censusLocked) continue;

            if (status.mission.census) {
                status.mission.census.count = status.assignedCount;
                status.mission.census.workParts = status.assignedWorkParts;
                status.mission.census.carryParts = status.assignedCarryParts;
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
        const towers = cache.myStructuresByType[STRUCTURE_TOWER] || [];
        towers.forEach(tower => {
            const bestMission = this.findBestTowerMission(tower, missionsSorted);
            if (bestMission) {
                this.assignTowerAction(tower, bestMission, room);
            }
        });
    },

    buildIdCache: function(room, missions) {
        if (room._idCacheTick === Game.time && room._idCache) return;
        const cache = new Map();

        const addId = (id) => {
            if (id) cache.set(id, null);
        };
        const addIds = (ids) => {
            if (!ids || ids.length === 0) return;
            ids.forEach(id => addId(id));
        };

        (missions || []).forEach(m => {
            addId(m.targetId);
            addIds(m.targetIds);
            addId(m.sourceId);
            addId(m.mineralId);

            const data = m.data;
            if (data) {
                addId(data.sourceId);
                addIds(data.sourceIds);
                addIds(data.targetIds);
                addId(data.containerId);
                addId(data.extractorId);
            }
        });

        for (const id of cache.keys()) {
            cache.set(id, Game.getObjectById(id));
        }
        room._idCache = cache;
        room._idCacheTick = Game.time;
    },

    getCachedObject: function(room, id) {
        if (!id) return null;
        if (room && room._idCache && room._idCache.has(id)) return room._idCache.get(id);
        return Game.getObjectById(id);
    },

    /**
     * Finds the most suitable mission for a creep based on priority and requirements.
     */
    findBestMission: function(creep, missionsSorted, missionStatus) {
        for (const m of missionsSorted) {
            // Exclude tower missions
            if (m.type.startsWith('tower')) continue;
            
            // Exclude fleet missions (they are for spawning only)
            if (m.type === 'hauler_fleet' || m.type === 'remote_hauler_fleet' || m.type === 'worker_fleet' || m.type === 'remote_worker_fleet') continue;

            // Exclude military missions (handled by military manager)
            if (m.type === 'defend' || m.type === 'patrol' || m.type === 'drain') continue;

            // Exclude combatants from economy missions
            if (['defender', 'brawler', 'drainer'].includes(creep.memory.role)) continue;

            const home = creep.memory.room;
            const awayFromHome = home && creep.room && creep.room.name !== home;
            if (awayFromHome && !this.isRemoteMission(m, home)) continue;

            const status = missionStatus[m.name];
            if (!status) continue;
            const req = m.requirements || {};

            // Check archetype match if specified
            if (req.archetype && req.archetype !== creep.memory.role) continue;

            // Check if requirements are met (Saturation check)
            if (req.count && status.assignedCount >= req.count) continue;

            // Check if creep is capable for this mission type
            if (m.type === 'harvest') {
                if (creep.getActiveBodyparts(WORK) === 0) continue;
            } else if (m.type === 'remote_harvest') {
                if (creep.getActiveBodyparts(WORK) === 0) continue;
            } else if (m.type === 'mineral') {
                if (creep.getActiveBodyparts(WORK) === 0) continue;
            } else if (m.type === 'upgrade' || m.type === 'build' || m.type === 'repair' || m.type === 'remote_build' || m.type === 'remote_repair') {
                if (creep.getActiveBodyparts(WORK) === 0 || creep.getActiveBodyparts(CARRY) === 0) continue;
            } else if (m.type === 'transfer' || m.type === 'remote_haul') {
                if (creep.getActiveBodyparts(CARRY) === 0) continue;
            } else if (m.type === 'dismantle') {
                if (creep.getActiveBodyparts(WORK) === 0) continue;
            } else if (m.type === 'remote_reserve') {
                if (creep.getActiveBodyparts(CLAIM) === 0) continue;
            }

            return m;
        }
        return null;
    },

    findBestTowerMission: function(tower, missionsSorted) {
        for (const m of missionsSorted) {
            if (m.type === 'tower_attack' || m.type === 'tower_heal' || m.type === 'tower_repair') return m;
        }
        return null;
    },

    assignAction: function(creep, mission, room) {
        if (mission.type === 'defend' || mission.type === 'patrol' || mission.type === 'drain') return;

        let task = null;
        switch (mission.type) {
            case 'hauler_fleet':
                // Release creep from fleet mission so it can pick up real work
                delete creep.memory.missionName;
                delete creep.memory.taskState;
                break;
            case 'remote_hauler_fleet':
                // Release creep from fleet mission so it can pick up real work
                delete creep.memory.missionName;
                delete creep.memory.taskState;
                break;
            case 'worker_fleet':
                // Release creep from fleet mission so it can pick up real work
                delete creep.memory.missionName;
                delete creep.memory.taskState;
                break;
            case 'remote_worker_fleet':
                // Release creep from fleet mission so it can pick up real work
                delete creep.memory.missionName;
                delete creep.memory.taskState;
                break;
            case 'harvest':
                task = this.getHarvestTask(creep, mission);
                break;
            case 'remote_harvest':
                task = this.getRemoteHarvestTask(creep, mission);
                break;
            case 'mineral':
                task = this.getMineralTask(creep, mission, room);
                break;
            case 'transfer':
                task = this.getTransferTask(creep, mission, room);
                break;
            case 'remote_haul':
                task = this.getRemoteHaulTask(creep, mission, room);
                break;
            case 'upgrade':
                task = this.getUpgradeTask(creep, mission, room);
                break;
            case 'build':
                task = this.getBuildTask(creep, mission, room);
                break;
            case 'remote_build':
                task = this.getRemoteBuildTask(creep, mission, room);
                break;
            case 'remote_repair':
                task = this.getRemoteRepairTask(creep, mission, room);
                break;
            case 'repair':
                task = this.getRepairTask(creep, mission, room);
                break;
            case 'decongest':
                task = this.getDecongestTask(creep, mission);
                break;
            case 'dismantle':
                task = this.getDismantleTask(creep, mission);
                break;
            case 'remote_reserve':
                task = this.getReserveTask(creep, mission);
                break;
            case 'scout':
                task = this.getScoutTask(creep, mission, room);
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
        const targets = targetIds.map(id => this.getCachedObject(tower.room, id)).filter(t => t);
        const target = tower.pos.findClosestByRange(targets);
        return target ? target.id : null;
    },

    toRoomPosition: function(pos) {
        if (!pos) return null;
        if (pos instanceof RoomPosition) return pos;
        if (!pos.roomName) return null;
        const x = Number(pos.x);
        const y = Number(pos.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return new RoomPosition(x, y, pos.roomName);
    },

    getDecongestTask: function(creep, mission) {
        // Stick to current target to prevent thrashing
        if (creep.memory.task && creep.memory.task.action === 'move') {
            if (creep.memory.task.targetId) {
                const currentTarget = this.getCachedObject(creep.room, creep.memory.task.targetId);
                if (currentTarget && (mission.targetIds || []).includes(currentTarget.id)) {
                    if (creep.pos.inRangeTo(currentTarget.pos, 1)) {
                        delete creep.memory.missionName;
                        delete creep.memory.taskState;
                        creep.say('parked');
                        return null;
                    }
                    return { action: 'move', targetId: currentTarget.id };
                }
            }
            if (creep.memory.task.targetName) {
                const currentTarget = Game.flags[creep.memory.task.targetName];
                if (currentTarget && (mission.targetNames || []).includes(currentTarget.name)) {
                    if (creep.pos.inRangeTo(currentTarget.pos, 1)) {
                        delete creep.memory.missionName;
                        delete creep.memory.taskState;
                        creep.say('parked');
                        return null;
                    }
                    return { action: 'move', targetName: currentTarget.name };
                }
            }
        }

        let targets = [];
        if (mission.targetIds) {
            targets = (mission.targetIds || []).map(id => this.getCachedObject(creep.room, id)).filter(t => t);
        } else if (mission.targetNames) {
            targets = (mission.targetNames || []).map(name => Game.flags[name]).filter(t => t);
        }

        if (targets.length > 0) {
            const target = creep.pos.findClosestByRange(targets);
            if (target) {
                // If we are already parked near a flag, release the creep to be idle
                if (creep.pos.inRangeTo(target.pos, 1)) {
                    delete creep.memory.missionName;
                    delete creep.memory.taskState;
                    creep.say('parked');
                    return null;
                }
                if (target instanceof Flag) {
                    return { action: 'move', targetName: target.name };
                }
                return { action: 'move', targetId: target.id };
            }
        }
        return null;
    },

    getDismantleTask: function(creep, mission) {
        const data = mission.data || {};
        const flagName = data.flagName;
        const flag = flagName ? Game.flags[flagName] : null;
        const targetPosData = data.targetPos;
        const toRoomPosition = (pos) => {
            if (!pos) return null;
            if (pos instanceof RoomPosition) return pos;
            if (!pos.roomName) return null;
            const x = Number(pos.x);
            const y = Number(pos.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
            return new RoomPosition(x, y, pos.roomName);
        };

        if (mission.targetId) {
            const target = this.getCachedObject(creep.room, mission.targetId) || Game.getObjectById(mission.targetId);
            if (target) {
                return { action: 'dismantle', targetId: target.id };
            }
        }

        if (flag) {
            const targetPos = flag.pos;
            if (creep.room.name !== targetPos.roomName) {
                return {
                    action: 'move',
                    targetPos: { x: targetPos.x, y: targetPos.y, roomName: targetPos.roomName },
                    range: 1
                };
            }

            const structures = targetPos.lookFor(LOOK_STRUCTURES);
            if (structures && structures.length > 0) {
                return { action: 'dismantle', targetId: structures[0].id };
            }

            if (!flag.memory || flag.memory.persist !== true) {
                flag.remove();
            }
        }

        const fallbackPos = toRoomPosition(targetPosData);
        if (fallbackPos) {
            if (creep.room.name !== fallbackPos.roomName) {
                return {
                    action: 'move',
                    targetPos: { x: fallbackPos.x, y: fallbackPos.y, roomName: fallbackPos.roomName },
                    range: 1
                };
            }

            const structures = fallbackPos.lookFor(LOOK_STRUCTURES);
            if (structures && structures.length > 0) {
                return { action: 'dismantle', targetId: structures[0].id };
            }
        }

        delete creep.memory.missionName;
        delete creep.memory.taskState;
        return null;
    },

    getReserveTask: function(creep, mission) {
        const data = mission.data || {};
        const targetRoom = data.targetRoom || (mission.targetPos && mission.targetPos.roomName) || (data.targetPos && data.targetPos.roomName);

        if (!targetRoom) {
            delete creep.memory.missionName;
            delete creep.memory.taskState;
            return null;
        }

        if (creep.room.name !== targetRoom) {
            const movePos = this.toRoomPosition(data.targetPos || mission.targetPos) || new RoomPosition(25, 25, targetRoom);
            return {
                action: 'move',
                targetPos: { x: movePos.x, y: movePos.y, roomName: movePos.roomName },
                range: 20
            };
        }

        const controller = creep.room.controller;
        if (!controller) {
            delete creep.memory.missionName;
            delete creep.memory.taskState;
            return null;
        }

        if (controller.owner && !controller.my) {
            if (data.persist !== true) {
                delete creep.memory.missionName;
                delete creep.memory.taskState;
            }
            return null;
        }

        if (controller.my) {
            if (data.persist !== true) {
                delete creep.memory.missionName;
                delete creep.memory.taskState;
            }
            return null;
        }

        return { action: 'reserve', targetId: controller.id, range: 1 };
    },

    getRemoteBuildTask: function(creep, mission, room) {
        const targetPos = this.toRoomPosition(mission.targetPos || (mission.data && mission.data.targetPos));
        const remoteRoom = (mission.data && mission.data.remoteRoom) || (targetPos && targetPos.roomName);
        const homeRoom = room || (creep.memory && creep.memory.room ? Game.rooms[creep.memory.room] : null);
        const homeRoomName = homeRoom ? homeRoom.name : (creep.memory && creep.memory.room);

        this.updateState(creep);
        const hasEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
        if (creep.memory.taskState === 'working' && !hasEnergy) {
            creep.memory.taskState = 'gathering';
        }

        if (creep.memory.taskState === 'working') {
            if (targetPos && creep.room.name !== targetPos.roomName) {
                return { action: 'move', targetPos: { x: targetPos.x, y: targetPos.y, roomName: targetPos.roomName }, range: 1 };
            }

            let target = null;
            if (mission.targetId) {
                target = this.getCachedObject(creep.room, mission.targetId) || Game.getObjectById(mission.targetId);
            }

            if (!target && targetPos && creep.room.name === targetPos.roomName) {
                const sites = targetPos.lookFor(LOOK_CONSTRUCTION_SITES);
                if (sites && sites.length > 0) target = sites[0];
            }

            if (!target && creep.room.name === (targetPos && targetPos.roomName)) {
                const roomSites = creep.room.find(FIND_CONSTRUCTION_SITES);
                if (roomSites.length > 0) target = creep.pos.findClosestByRange(roomSites);
            }

            if (target) return { action: 'build', targetId: target.id };

            delete creep.memory.missionName;
            delete creep.memory.taskState;
            return null;
        }

        if (homeRoomName && creep.room.name !== homeRoomName) {
            const anchor = homeRoom && homeRoom.storage ? homeRoom.storage.pos
                : (homeRoom && homeRoom.controller ? homeRoom.controller.pos : null);
            const movePos = anchor || { x: 25, y: 25, roomName: homeRoomName };
            return { action: 'move', targetPos: { x: movePos.x, y: movePos.y, roomName: movePos.roomName }, range: 3 };
        }

        const gatherRoom = homeRoom || creep.room;
        const task = this.getGatherTask(creep, gatherRoom, {});
        if (task) return task;
        if (targetPos && creep.room.name !== targetPos.roomName) {
            return { action: 'move', targetPos: { x: targetPos.x, y: targetPos.y, roomName: targetPos.roomName }, range: 1 };
        }
        return null;
    },

    getRemoteRepairTask: function(creep, mission, room) {
        const targetPos = this.toRoomPosition(mission.targetPos || (mission.data && mission.data.targetPos));
        const remoteRoom = (mission.data && mission.data.remoteRoom) || (targetPos && targetPos.roomName);
        const homeRoom = room || (creep.memory && creep.memory.room ? Game.rooms[creep.memory.room] : null);
        const homeRoomName = homeRoom ? homeRoom.name : (creep.memory && creep.memory.room);

        this.updateState(creep);
        const hasEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
        if (creep.memory.taskState === 'working' && !hasEnergy) {
            creep.memory.taskState = 'gathering';
        }

        if (creep.memory.taskState === 'working') {
            if (targetPos && creep.room.name !== targetPos.roomName) {
                return { action: 'move', targetPos: { x: targetPos.x, y: targetPos.y, roomName: targetPos.roomName }, range: 1 };
            }

            let target = null;
            if (mission.targetId) {
                target = this.getCachedObject(creep.room, mission.targetId) || Game.getObjectById(mission.targetId);
            }

            if (!target && targetPos && creep.room.name === targetPos.roomName) {
                const structures = targetPos.lookFor(LOOK_STRUCTURES);
                const repairable = structures.find(s =>
                    (s.structureType === STRUCTURE_ROAD || s.structureType === STRUCTURE_CONTAINER) &&
                    s.hits < s.hitsMax
                );
                if (repairable) target = repairable;
            }

            if (!target && creep.room.name === (targetPos && targetPos.roomName)) {
                const roomTargets = creep.room.find(FIND_STRUCTURES, {
                    filter: s => (s.structureType === STRUCTURE_ROAD || s.structureType === STRUCTURE_CONTAINER) &&
                        s.hits < s.hitsMax
                });
                if (roomTargets.length > 0) target = creep.pos.findClosestByRange(roomTargets);
            }

            if (target && target.hits < target.hitsMax) return { action: 'repair', targetId: target.id };

            delete creep.memory.missionName;
            delete creep.memory.taskState;
            return null;
        }

        if (homeRoomName && creep.room.name !== homeRoomName) {
            const anchor = homeRoom && homeRoom.storage ? homeRoom.storage.pos
                : (homeRoom && homeRoom.controller ? homeRoom.controller.pos : null);
            const movePos = anchor || { x: 25, y: 25, roomName: homeRoomName };
            return { action: 'move', targetPos: { x: movePos.x, y: movePos.y, roomName: movePos.roomName }, range: 3 };
        }

        const gatherRoom = homeRoom || creep.room;
        const task = this.getGatherTask(creep, gatherRoom, {});
        if (task) return task;
        if (targetPos && creep.room.name !== targetPos.roomName) {
            return { action: 'move', targetPos: { x: targetPos.x, y: targetPos.y, roomName: targetPos.roomName }, range: 1 };
        }
        return null;
    },

    getRemoteHarvestTask: function(creep, mission) {
        const data = mission.data || {};
        const sourcePos = this.toRoomPosition(data.sourcePos || mission.pos);
        const remoteRoom = data.remoteRoom || (sourcePos && sourcePos.roomName);
        const containerPos = this.toRoomPosition(data.containerPos);

        if (remoteRoom && creep.room.name !== remoteRoom) {
            if (sourcePos) {
                return { action: 'move', targetPos: { x: sourcePos.x, y: sourcePos.y, roomName: sourcePos.roomName }, range: 1 };
            }
            return { action: 'move', targetPos: { x: 25, y: 25, roomName: remoteRoom }, range: 20 };
        }

        const container = data.containerId ? Game.getObjectById(data.containerId) : null;
        if (container && !creep.pos.isEqualTo(container.pos)) {
            const creepsOnContainer = container.pos.lookFor(LOOK_CREEPS);
            if (creepsOnContainer.length === 0 || (creepsOnContainer.length === 1 && creepsOnContainer[0].id === creep.id)) {
                return { action: 'move', targetPos: { x: container.pos.x, y: container.pos.y, roomName: container.pos.roomName }, range: 0 };
            }
        } else if (!container && containerPos && !creep.pos.isEqualTo(containerPos)) {
            return { action: 'move', targetPos: { x: containerPos.x, y: containerPos.y, roomName: containerPos.roomName }, range: 0 };
        }

        this.updateState(creep);
        if (creep.memory.taskState === 'working' && creep.getActiveBodyparts(CARRY) > 0) {
            if (container && creep.pos.inRangeTo(container.pos, 1) && container.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                return { action: 'transfer', targetId: container.id, resourceType: RESOURCE_ENERGY };
            }
            // Static mining: if no transfer target, fall through to harvest (mirrors local miner behavior).
        }

        const source = mission.sourceId ? Game.getObjectById(mission.sourceId) : null;
        if (source) return { action: 'harvest', targetId: source.id };
        if (sourcePos) return { action: 'move', targetPos: { x: sourcePos.x, y: sourcePos.y, roomName: sourcePos.roomName }, range: 1 };
        return null;
    },

    getRemoteHaulTask: function(creep, mission, room) {
        const data = mission.data || {};
        const resourceType = data.resourceType || RESOURCE_ENERGY;
        const pickupPos = this.toRoomPosition(data.pickupPos);
        const dropoffPos = this.toRoomPosition(data.dropoffPos);

        this.updateState(creep, resourceType);

        if (creep.memory.taskState === 'working') {
            if (dropoffPos && creep.room.name !== dropoffPos.roomName) {
                return { action: 'move', targetPos: { x: dropoffPos.x, y: dropoffPos.y, roomName: dropoffPos.roomName }, range: 1 };
            }

            let target = data.dropoffId ? Game.getObjectById(data.dropoffId) : null;
            if (!target) {
                const cache = global.getRoomCache(creep.room);
                const storage = (cache.myStructuresByType[STRUCTURE_STORAGE] || [])[0];
                if (storage) target = storage;
                if (!target) {
                    const spawns = cache.myStructuresByType[STRUCTURE_SPAWN] || [];
                    target = creep.pos.findClosestByRange(spawns);
                }
            }

            if (target) {
                if (target.store && target.store.getFreeCapacity(resourceType) === 0) {
                    delete creep.memory.missionName;
                    delete creep.memory.taskState;
                    return null;
                }
                return { action: 'transfer', targetId: target.id, resourceType: resourceType };
            }
            return null;
        }

        if (pickupPos && creep.room.name !== pickupPos.roomName) {
            return { action: 'move', targetPos: { x: pickupPos.x, y: pickupPos.y, roomName: pickupPos.roomName }, range: 1 };
        }

        const pickup = data.pickupId ? Game.getObjectById(data.pickupId) : null;
        if (pickup && pickup.store && (pickup.store[resourceType] || 0) > 0) {
            return { action: 'withdraw', targetId: pickup.id, resourceType: resourceType };
        }

        const cache = global.getRoomCache(creep.room);
        const tombstone = creep.pos.findClosestByRange(cache.tombstones || [], {
            filter: t => t.store && (t.store[resourceType] || 0) > 50
        });
        if (tombstone) return { action: 'withdraw', targetId: tombstone.id, resourceType: resourceType };

        const dropped = creep.pos.findClosestByRange(cache.dropped || [], {
            filter: r => r.resourceType === resourceType && r.amount > 50
        });
        if (dropped) return { action: 'pickup', targetId: dropped.id };

        return null;
    },

    getScoutTask: function(creep, mission, room) {
        const data = mission.data || {};
        const sponsorRoom = data.sponsorRoom || room.name;
        const rooms = Array.isArray(data.rooms) ? data.rooms : [];
        const interval = Number.isFinite(data.interval) ? data.interval : 500;

        creep.memory.scout = {
            sponsorRoom,
            rooms,
            interval
        };

        return null;
    },

    // --- Task Generators ---

    getHarvestTask: function(creep, mission) {
        const cache = global.getRoomCache(creep.room);
        // 1. Static Mining Positioning
        if (mission.data && mission.data.containerId) {
            const container = this.getCachedObject(creep.room, mission.data.containerId);
            if (container && !creep.pos.isEqualTo(container.pos)) {
                // Only move to container if it is not occupied by another creep
                const creepsOnContainer = container.pos.lookFor(LOOK_CREEPS);
                if (creepsOnContainer.length === 0) {
                    return { action: 'move', targetId: mission.data.containerId, range: 0 };
                }
            }
        }

        // 2. Check Capacity (Mobile Mining / Link Transfer)
        this.updateState(creep);
        if (creep.memory.taskState === 'working' && creep.getActiveBodyparts(CARRY) > 0) {
            const nearby = [
                ...(cache.structuresByType[STRUCTURE_CONTAINER] || []),
                ...(cache.structuresByType[STRUCTURE_LINK] || [])
            ].filter(s => creep.pos.inRangeTo(s.pos, 1));
            
            const transferTarget = nearby.find(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);

            if (transferTarget) {
                return { action: 'transfer', targetId: transferTarget.id, resourceType: RESOURCE_ENERGY };
            }
            
            // Determine if we should behave as static miner
            const isStatic = (mission.data && mission.data.mode === 'static') || 
                             (nearby.length > 0 && (!mission.data || mission.data.mode !== 'mobile'));

            if (!isStatic) {
                // No container nearby: Mobile Mining behavior. Deliver to Spawn/Extension.
                const primaryTargets = [
                    ...(cache.myStructuresByType[STRUCTURE_SPAWN] || []),
                    ...(cache.myStructuresByType[STRUCTURE_EXTENSION] || [])
                ].filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
                let deliveryTarget = creep.pos.findClosestByRange(primaryTargets);

                if (!deliveryTarget) {
                    const secondaryTargets = [
                        ...(cache.myStructuresByType[STRUCTURE_TOWER] || []).filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 50),
                        ...(cache.myStructuresByType[STRUCTURE_STORAGE] || []).filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0)
                    ];
                    deliveryTarget = creep.pos.findClosestByRange(secondaryTargets);
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
            // If isStatic, fall through to harvest (step 3)
        }

        // 3. Harvest
        return { action: 'harvest', targetId: mission.sourceId };
    },

    getMineralTask: function(creep, mission, room) {
        const mineral = mission.mineralId ? this.getCachedObject(creep.room, mission.mineralId) : null;
        if (!mineral || mineral.mineralAmount <= 0) {
            delete creep.memory.missionName;
            delete creep.memory.taskState;
            return null;
        }

        if (mission.data && mission.data.extractorId) {
            const extractor = this.getCachedObject(creep.room, mission.data.extractorId);
            if (!extractor) {
                delete creep.memory.missionName;
                delete creep.memory.taskState;
                return null;
            }
        }

        const resourceType = (mission.data && mission.data.resourceType) ? mission.data.resourceType : mineral.mineralType;
        const container = (mission.data && mission.data.containerId)
            ? this.getCachedObject(creep.room, mission.data.containerId)
            : null;
        const terminal = room && room.terminal ? room.terminal : null;
        const storage = room && room.storage ? room.storage : null;

        const carriedTypes = Object.keys(creep.store).filter(r => creep.store[r] > 0);
        if (carriedTypes.length > 0) {
            const depositType = carriedTypes.includes(resourceType) ? resourceType : carriedTypes[0];
            const terminalHasSpace = terminal && terminal.store.getFreeCapacity(depositType) > 0;
            const storageHasSpace = storage && storage.store.getFreeCapacity(depositType) > 0;
            const containerHasSpace = container && container.store.getFreeCapacity(depositType) > 0;
            const depositTarget = terminalHasSpace ? terminal : (storageHasSpace ? storage : (containerHasSpace ? container : null));

            // If we're already adjacent to the container, keep it emptied to avoid overflow.
            if (depositTarget === container && creep.pos.inRangeTo(container.pos, 1)) {
                return { action: 'transfer', targetId: container.id, resourceType: depositType };
            }

            // Only haul when full; otherwise keep mining.
            if (creep.store.getFreeCapacity() === 0) {
                if (depositTarget) {
                    if (depositTarget === container) {
                        if (creep.pos.inRangeTo(container.pos, 1)) {
                            return { action: 'transfer', targetId: container.id, resourceType: depositType };
                        }
                        return { action: 'move', targetId: container.id, range: 0 };
                    }
                    return { action: 'transfer', targetId: depositTarget.id, resourceType: depositType };
                }
                return { action: 'drop', resourceType: depositType };
            }
        }

        if (container && !creep.pos.isEqualTo(container.pos)) {
            const creepsOnContainer = container.pos.lookFor(LOOK_CREEPS);
            if (creepsOnContainer.length === 0) {
                return { action: 'move', targetId: container.id, range: 0 };
            }
        }

        return { action: 'harvest', targetId: mineral.id };
    },

    getTransferTask: function(creep, mission, room) {
        const resourceType = (mission.data && mission.data.resourceType) ? mission.data.resourceType : RESOURCE_ENERGY;
        this.updateState(creep, resourceType);
        if (creep.memory.taskState === 'working') {
            let target = null;
            
            if (resourceType === RESOURCE_ENERGY &&
                mission.targetType === 'transfer_list' &&
                mission.data &&
                mission.data.targetIds) {
                const targets = mission.data.targetIds
                    .map(id => this.getCachedObject(creep.room, id))
                    .filter(t => t && t.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
                target = creep.pos.findClosestByRange(targets);
            }

            if (!target && mission.targetId) {
                target = this.getCachedObject(creep.room, mission.targetId);
            }

            if (target) {
                if (target.store && target.store.getFreeCapacity(resourceType) === 0) {
                    delete creep.memory.missionName;
                    delete creep.memory.taskState;
                    return null;
                }
                return { action: 'transfer', targetId: target.id, resourceType: resourceType };
            }

            if (resourceType !== RESOURCE_ENERGY) {
                delete creep.memory.missionName;
                delete creep.memory.taskState;
                return null;
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
            if (resourceType !== RESOURCE_ENERGY && mission.data && mission.data.sourceId) {
                const source = this.getCachedObject(creep.room, mission.data.sourceId);
                if (source && source.store && (source.store[resourceType] || 0) > 0) {
                    return { action: 'withdraw', targetId: source.id, resourceType: resourceType };
                }
                delete creep.memory.missionName;
                delete creep.memory.taskState;
                return null;
            }

            // If specific source is defined in mission data, use it
            let task = null;
            if (mission.data && mission.data.sourceId) {
                task = this.getGatherTask(creep, room, { allowedIds: [mission.data.sourceId] });
            } else {
                const allowedIds = (mission.data && mission.data.sourceIds) ? mission.data.sourceIds : null;
                const excludeIds = (mission.data && mission.data.targetIds) ? mission.data.targetIds : null;
                task = this.getGatherTask(creep, room, { allowedIds, excludeIds });
            }

            if (!task) {
                delete creep.memory.missionName;
                delete creep.memory.taskState;
                return null;
            }
            return task;
        }
        return null;
    },

    getUpgradeTask: function(creep, mission, room) {
        this.updateState(creep);
        if (creep.memory.taskState === 'working') {
            return { action: 'upgrade', targetId: mission.targetId };
        } else {
            const allowedIds = (mission.data && mission.data.sourceIds) ? mission.data.sourceIds : null;
            const task = this.getGatherTask(creep, room, { allowedIds });
            if (!task) {
                delete creep.memory.missionName;
                delete creep.memory.taskState;
                return null;
            }
            return task;
        }
    },

    getBuildTask: function(creep, mission, room) {
        this.updateState(creep);
        if (creep.memory.taskState === 'working') {
            const targetId = mission.targetId || (mission.targetIds && mission.targetIds[0]);
            const target = targetId ? this.getCachedObject(creep.room, targetId) : null;
            if (target) return { action: 'build', targetId: target.id };

            delete creep.memory.missionName;
            delete creep.memory.taskState;
            return null;
        } else {
            // If specific source is defined in mission data, use it
            let task = null;
            if (mission.data && mission.data.sourceId) {
                task = this.getGatherTask(creep, room, { allowedIds: [mission.data.sourceId] });
            } else {
                const allowedIds = (mission.data && mission.data.sourceIds) ? mission.data.sourceIds : null;
                const excludeIds = (mission.data && mission.data.targetIds) ? mission.data.targetIds : null;
                task = this.getGatherTask(creep, room, { allowedIds, excludeIds });
            }

            if (!task) {
                delete creep.memory.missionName;
                delete creep.memory.taskState;
                return null;
            }
            return task;
        }
        return null;
    },

    getRepairTask: function(creep, mission, room) {
        this.updateState(creep);
        if (creep.memory.taskState === 'working') {
            const targetId = mission.targetId || (mission.targetIds && mission.targetIds[0]);
            const target = targetId ? this.getCachedObject(creep.room, targetId) : null;
            if (target && target.hits < target.hitsMax) {
                return { action: 'repair', targetId: target.id };
            }

            delete creep.memory.missionName;
            delete creep.memory.taskState;
            return null;
        } else {
            // If specific source is defined in mission data, use it
            let task = null;
            if (mission.data && mission.data.sourceId) {
                task = this.getGatherTask(creep, room, { allowedIds: [mission.data.sourceId] });
            } else {
                const allowedIds = (mission.data && mission.data.sourceIds) ? mission.data.sourceIds : null;
                const excludeIds = (mission.data && mission.data.targetIds) ? mission.data.targetIds : null;
                task = this.getGatherTask(creep, room, { allowedIds, excludeIds });
            }

            if (!task) {
                delete creep.memory.missionName;
                delete creep.memory.taskState;
                return null;
            }
            return task;
        }
        return null;
    },

    updateState: function(creep, resourceType) {
        // State Machine: working <-> idle <-> gathering
        const type = resourceType || RESOURCE_ENERGY;
        
        // Transition from Working to Idle
        if (creep.memory.taskState === 'working' && creep.store.getUsedCapacity(type) === 0) {
            creep.memory.taskState = 'idle';
            creep.say('idle');
        }
        
        // Transition from Gathering to Idle
        if (creep.memory.taskState === 'gathering' && creep.store.getFreeCapacity() === 0) {
            creep.memory.taskState = 'idle';
            creep.say('idle');
        }

        // Transition from Idle/Init to Working or Gathering
        if (creep.memory.taskState === 'idle' || creep.memory.taskState === 'init' || !creep.memory.taskState) {
            if (creep.store.getUsedCapacity(type) > 0) {
                creep.memory.taskState = 'working';
                creep.say('work');
            } else {
                creep.memory.taskState = 'gathering';
                creep.say('gather');
            }
        }
    },

    getGatherTask: function(creep, room, options = {}) {
        // Ensure reservation table exists (safety check)
        if (!room._reservedEnergy) room._reservedEnergy = {};
        const cache = global.getRoomCache(room);

        const allowedIds = options.allowedIds || null;
        const excludeIds = options.excludeIds || [];

        // 0. Specific Allowed Sources (Tight Logistics)
        if (allowedIds && allowedIds.length > 0) {
            const targets = allowedIds.map(id => this.getCachedObject(creep.room, id)).filter(t => t);
            // Find closest valid target from the allowed list
            const valid = targets.filter(t => {
                if (excludeIds.includes(t.id)) return false;
                
                // Check energy availability
                let amount = 0;
                if (t instanceof Resource) amount = t.amount;
                else if (t.store) amount = t.store[RESOURCE_ENERGY];
                
                // Reserve check
                const reserved = room._reservedEnergy[t.id] || 0;
                return (amount - reserved) > 0;
            });

            const target = creep.pos.findClosestByRange(valid);
            if (target) {
                room._reservedEnergy[target.id] = (room._reservedEnergy[target.id] || 0) + creep.store.getFreeCapacity();
                if (target instanceof Resource) return { action: 'pickup', targetId: target.id };
                return { action: 'withdraw', targetId: target.id, resourceType: RESOURCE_ENERGY };
            }
            
            if (creep.store[RESOURCE_ENERGY] > 0) {
                creep.memory.taskState = 'working';
            }
            
            // If restricted to specific sources and none are available, return null (idle)
            return null;
        }

        // 1. Pickup Dropped
        const dropped = creep.pos.findClosestByRange(cache.dropped || [], {
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
        const storageAndContainers = [
            ...(cache.structuresByType[STRUCTURE_CONTAINER] || []),
            ...(cache.structuresByType[STRUCTURE_STORAGE] || [])
        ];
        const validStructures = storageAndContainers.filter(s => {
            if (allowedIds && !allowedIds.includes(s.id)) return false;
            if (excludeIds.includes(s.id)) return false;
            const energy = s.store[RESOURCE_ENERGY];
            const reserved = room._reservedEnergy[s.id] || 0;
            return (energy - reserved) >= 50;
        });
        const structure = creep.pos.findClosestByRange(validStructures);
        if (structure) {
            room._reservedEnergy[structure.id] = (room._reservedEnergy[structure.id] || 0) + creep.store.getFreeCapacity();
            return { action: 'withdraw', targetId: structure.id, resourceType: RESOURCE_ENERGY };
        }

        // 3. Harvest (if capable)
        if (creep.getActiveBodyparts(WORK) > 0) {
            const source = creep.pos.findClosestByRange(cache.sourcesActive || []);
            if (source) {
                return { action: 'harvest', targetId: source.id };
            }
        }
        return null;
    }
};

module.exports = managerTasks;
