const execBuildTask = require('managers_overseer_tasks_exec_build');
const execRepairTask = require('managers_overseer_tasks_exec_repair');
const execUpgradeTask = require('managers_overseer_tasks_exec_upgrade');
const execHarvestTask = require('managers_overseer_tasks_exec_harvest');
const execRemoteHarvestTask = require('managers_overseer_tasks_exec_remoteHarvest');
const execMineralTask = require('managers_overseer_tasks_exec_mineral');
const execTransferTask = require('managers_overseer_tasks_exec_transfer');
const execRemoteHaulTask = require('managers_overseer_tasks_exec_remoteHaul');
const execRemoteBuildTask = require('managers_overseer_tasks_exec_remoteBuild');
const execRemoteRepairTask = require('managers_overseer_tasks_exec_remoteRepair');
const execDecongestTask = require('managers_overseer_tasks_exec_decongest');
const execDismantleTask = require('managers_overseer_tasks_exec_dismantle');
const execReserveTask = require('managers_overseer_tasks_exec_reserve');
const execClaimTask = require('managers_overseer_tasks_exec_claim');
const execScoutTask = require('managers_overseer_tasks_exec_scout');

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
/**
 * @typedef {Object} TaskIntent
 * @property {'move'|'withdraw'|'transfer'|'harvest'|'build'|'repair'|'upgrade'|'pickup'|'dismantle'|'reserve'|'claim'|'drop'} type
 * @property {string=} targetId
 * @property {string=} targetName
 * @property {{x:number,y:number,roomName:string}=} targetPos
 * @property {string=} resourceType
 * @property {number=} amount
 * @property {number=} range
 * @property {Object=} meta
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
        // Only manage creeps owned by this home room.
        // Foreign creeps in the room should be managed by their own home room via remote-by-home.
        const localCreeps = (cache.myCreeps || []).filter(c =>
            c && c.my && c.memory && c.memory.room === room.name
        );
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
                        const isTravellingHome = creep.memory._travellingToHome === true ||
                            (creep.memory.spawnRoom && creep.memory.spawnRoom !== creep.memory.room);
                        if (!isTravellingHome) {
                            delete creep.memory.missionName;
                            delete creep.memory.taskState;
                            delete creep.memory.scout;
                            delete creep.memory.task;
                            creep.say('home');
                            return;
                        }
                        if (!creep.memory.task) {
                            const homeRoom = Game.rooms[home];
                            const targetPos = (homeRoom && homeRoom.controller)
                                ? homeRoom.controller.pos
                                : new RoomPosition(25, 25, home);
                            creep.memory.task = {
                                action: 'move',
                                targetPos: { x: targetPos.x, y: targetPos.y, roomName: targetPos.roomName },
                                range: 5
                            };
                        }
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
                    
                    // Update Reservation to ACTIVE if working
                    if (creep.memory.ticketId) {
                        this.updateReservation(creep, 'ACTIVE');
                    } else if (creep.ticksToLive > 1450) { // Bootstrap check for EN_ROUTE
                         // Handled in idle loop or specific check below
                    }

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

        // Bootstrap EN_ROUTE state for new creeps
        idleCreeps.forEach(creep => {
            if (creep.memory.ticketId) {
                this.updateReservation(creep, 'EN_ROUTE');
            }
        });

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
                
                if (creep.memory.ticketId) this.updateReservation(creep, 'ACTIVE');

                creep.say(bestMission.type);
                if (creep.memory.idleTicks) delete creep.memory.idleTicks;
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

        // 4.6 Recycle if idle for too long in home room (Remote Creeps)
        idleCreeps.forEach(creep => {
            if (creep.memory.missionName) return;

            const home = creep.memory.room;
            if (home && creep.room.name === home) {
                const role = creep.memory.role || '';
                const isRemote = role.startsWith('remote_');
                
                if (isRemote) {
                    creep.memory.idleTicks = (creep.memory.idleTicks || 0) + 1;
                    if (creep.memory.idleTicks > 50) {
                        const spawns = cache.myStructuresByType[STRUCTURE_SPAWN] || [];
                        const spawn = creep.pos.findClosestByRange(spawns);
                        if (spawn) {
                            if (creep.pos.isNearTo(spawn)) {
                                spawn.recycleCreep(creep);
                            } else {
                                creep.memory.task = {
                                    action: 'move',
                                    targetId: spawn.id,
                                    range: 1
                                };
                            }
                            creep.say('recycle');
                        }
                    }
                }
            } else {
                if (creep.memory.idleTicks) delete creep.memory.idleTicks;
            }
        });

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

    updateReservation: function(creep, state) {
        const ticketId = creep.memory.ticketId;
        if (!ticketId || !Memory.spawnTickets || !Memory.spawnTickets[ticketId]) return;
        const ticket = Memory.spawnTickets[ticketId];
        if (state === 'EN_ROUTE' && ticket.state !== 'ACTIVE') {
            ticket.state = 'EN_ROUTE';
            ticket.creepName = creep.name;
            ticket.expiresAt = Game.time + 1500;
        } else if (state === 'ACTIVE') {
            ticket.state = 'ACTIVE';
            ticket.creepName = creep.name;
            ticket.expiresAt = Game.time + 50;
        }
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

    getMissionPosition: function(mission, room) {
        if (mission.pos) return mission.pos;
        if (mission.targetPos) return this.toRoomPosition(mission.targetPos);
        if (mission.data) {
            if (mission.data.targetPos) return this.toRoomPosition(mission.data.targetPos);
            if (mission.data.sourcePos) return this.toRoomPosition(mission.data.sourcePos);
            if (mission.data.pickupPos) return this.toRoomPosition(mission.data.pickupPos);
        }
        if (mission.targetId) {
            const target = this.getCachedObject(room, mission.targetId);
            if (target) return target.pos;
        }
        return null;
    },

    /**
     * Finds the most suitable mission for a creep based on priority and requirements.
     */
    findBestMission: function(creep, missionsSorted, missionStatus) {
        let bestPriority = null;
        const candidates = [];

        for (const m of missionsSorted) {
            // Optimization: If we found a priority group and this mission is lower, stop.
            const priority = m.priority || 0;
            if (bestPriority !== null && priority < bestPriority) {
                break;
            }

            // Exclude tower missions
            if (m.type.startsWith('tower')) continue;
            
            // Exclude fleet missions (they are for spawning only)
            if (m.type === 'hauler_fleet' || m.type === 'remote_hauler_fleet' || m.type === 'worker_fleet' || m.type === 'remote_worker_fleet') continue;

            // Exclude military missions (handled by military manager)
            if (m.type === 'defend' || m.type === 'patrol' || m.type === 'drain') continue;

            // Exclude combatants from economy missions
            if (['defender', 'brawler', 'drainer', 'assault'].includes(creep.memory.role)) continue;

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
            } else if (m.type === 'remote_claim') {
                if (creep.getActiveBodyparts(CLAIM) === 0) continue;
            }

            // Mission is valid
            if (bestPriority === null) {
                bestPriority = priority;
            }
            candidates.push(m);
        }

        if (candidates.length > 0) {
            // If only one candidate, return it.
            if (candidates.length === 1) return candidates[0];

            // Map candidates to objects with pos for findClosestByRange
            const mapped = [];
            for (const m of candidates) {
                const pos = this.getMissionPosition(m, creep.room);
                if (pos) {
                    mapped.push({ mission: m, pos: pos });
                }
            }

            // If we have positions, find the closest one
            if (mapped.length > 0) {
                const closest = creep.pos.findClosestByRange(mapped);
                if (closest) return closest.mission;
            }

            // Fallback: return the first candidate (highest priority / first generated)
            return candidates[0];
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
                task = execHarvestTask({ creep, mission, room });
                break;
            case 'remote_harvest':
                task = execRemoteHarvestTask({ creep, mission, room });
                break;
            case 'mineral':
                task = execMineralTask({ creep, mission, room });
                break;
            case 'transfer':
                task = execTransferTask({ creep, mission, room });
                break;
            case 'remote_haul':
                task = execRemoteHaulTask({ creep, mission, room });
                break;
            case 'upgrade':
                task = execUpgradeTask({ creep, mission, room });
                break;
            case 'build':
                task = execBuildTask({ creep, mission, room });
                break;
            case 'remote_build':
                task = execRemoteBuildTask({ creep, mission, room });
                break;
            case 'remote_repair':
                task = execRemoteRepairTask({ creep, mission, room });
                break;
            case 'repair':
                task = execRepairTask({ creep, mission, room });
                break;
            case 'decongest':
                task = execDecongestTask({ creep, mission, room });
                break;
            case 'dismantle':
                task = execDismantleTask({ creep, mission, room });
                break;
            case 'remote_reserve':
                task = execReserveTask({ creep, mission, room });
                break;
            case 'remote_claim':
                task = execClaimTask({ creep, mission, room });
                break;
            case 'scout':
                task = execScoutTask({ creep, mission, room });
                break;
        }

        const intent = this.normalizeTaskIntent(task);
        const legacyTask = this.toLegacyTask(intent);

        if (global.DEBUG_TASKS) {
            const targetId = legacyTask ? (legacyTask.targetId || legacyTask.targetName || null) : null;
            const resourceType = legacyTask && legacyTask.resourceType ? legacyTask.resourceType : null;
            const action = legacyTask ? legacyTask.action : 'none';
            console.log(`[tasks] creep=${creep.name} mission=${mission.name} action=${action} targetId=${targetId} resourceType=${resourceType}`);
        }

        if (legacyTask) {
            creep.memory.task = legacyTask;
        } else {
            //console.log(`[tasks] creep=${creep.name} mission=${mission.name} no task produced`);
            delete creep.memory.task;
        }
    },

    assignTowerAction: function(tower, mission, room) {
        let action = null;
        let targetId = null;

        if (mission.type === 'tower_attack') {
            action = 'attack';
            targetId = this.findBestTarget(tower, mission.targetIds, action);
        } else if (mission.type === 'tower_heal') {
            action = 'heal';
            targetId = this.findBestTarget(tower, mission.targetIds, action);
        } else if (mission.type === 'tower_repair') {
            action = 'repair';
            targetId = this.findBestTarget(tower, mission.targetIds, action);
        }

        if (action && targetId) {
            room._towerTasks[tower.id] = { action, targetId };
        }
    },

    findBestTarget: function(tower, targetIds, action) {
        if (!targetIds || targetIds.length === 0) return null;
        const targets = targetIds.map(id => this.getCachedObject(tower.room, id)).filter(t => t);
        if (targets.length === 0) return null;

        if (action !== 'attack') {
            const target = tower.pos.findClosestByRange(targets);
            return target ? target.id : null;
        }

        const creepTargets = targets.filter(t => t instanceof Creep || t instanceof PowerCreep);
        if (creepTargets.length === 0) {
            const target = tower.pos.findClosestByRange(targets);
            return target ? target.id : null;
        }

        const getTowerDamageAtRange = (range) => {
            const clamped = Math.max(1, Math.min(range || 20, 50));
            if (clamped <= 5) return 600;
            if (clamped >= 20) return 150;
            return 600 - ((clamped - 5) * 30);
        };

        const getHealPower = (creep) => {
            if (!creep) return 0;
            if (!creep.body) {
                return creep.getActiveBodyparts ? creep.getActiveBodyparts(HEAL) * 12 : 0;
            }
            let total = 0;
            for (const part of creep.body) {
                if (part.type !== HEAL || part.hits <= 0) continue;
                let multiplier = 1;
                if (part.boost && global.BOOSTS && BOOSTS[HEAL] && BOOSTS[HEAL][part.boost]) {
                    multiplier = BOOSTS[HEAL][part.boost].heal || 1;
                }
                total += 12 * multiplier;
            }
            return total;
        };

        const healers = creepTargets.filter(c => c.getActiveBodyparts && c.getActiveBodyparts(HEAL) > 0);
        const healerPower = {};
        for (const healer of healers) {
            healerPower[healer.id] = getHealPower(healer);
        }

        const stats = creepTargets.map(target => {
            const range = tower.pos.getRangeTo(target.pos);
            const towerDamage = getTowerDamageAtRange(range);
            let healingReceived = 0;
            for (const healer of healers) {
                if (healer.pos.inRangeTo(target.pos, 3)) {
                    healingReceived += healerPower[healer.id] || 0;
                }
            }
            const netDamage = towerDamage - healingReceived;
            const shotsToKill = netDamage > 0 ? Math.ceil(target.hits / netDamage) : Infinity;
            return {
                target,
                range,
                towerDamage,
                healingReceived,
                netDamage,
                shotsToKill,
                healPower: healerPower[target.id] || 0
            };
        });

        const QUICK_KILL_SHOTS = 3;
        const quickKills = stats.filter(s => s.shotsToKill <= QUICK_KILL_SHOTS);
        if (quickKills.length > 0) {
            quickKills.sort((a, b) => (a.shotsToKill - b.shotsToKill) || (a.range - b.range));
            return quickKills[0].target.id;
        }

        const unkillableTargets = stats.filter(s => s.netDamage <= 0);
        if (unkillableTargets.length > 0 && healers.length > 0) {
            const blockingHealers = stats.filter(s => s.healPower > 0 && unkillableTargets.some(u => s.target.pos.inRangeTo(u.target.pos, 3)));
            if (blockingHealers.length > 0) {
                blockingHealers.sort((a, b) => (b.healPower - a.healPower) || (a.range - b.range));
                return blockingHealers[0].target.id;
            }
        }

        const killable = stats.filter(s => s.shotsToKill !== Infinity);
        if (killable.length > 0) {
            killable.sort((a, b) => (a.shotsToKill - b.shotsToKill) || (a.range - b.range));
            return killable[0].target.id;
        }

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

    normalizeTaskIntent: function(intent) {
        if (!intent) return null;
        if (intent.type) return intent;
        if (intent.action) {
            const { action, ...rest } = intent;
            return { ...rest, type: action };
        }
        return intent;
    },

    toLegacyTask: function(intent) {
        if (!intent) return null;
        if (intent.action) return intent;
        const { type, ...rest } = intent;
        return { ...rest, action: type };
    },

};

module.exports = managerTasks;
