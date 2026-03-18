const { profRequire } = require('utils_profRequire');

const execBuildTask = profRequire('managers_overseer_tasks_exec_build', 'tasks.exec.build');
const execRepairTask = profRequire('managers_overseer_tasks_exec_repair', 'tasks.exec.repair');
const execUpgradeTask = profRequire('managers_overseer_tasks_exec_upgrade', 'tasks.exec.upgrade');
const execHarvestTask = profRequire('managers_overseer_tasks_exec_harvest', 'tasks.exec.harvest');
const execRemoteHarvestTask = profRequire('managers_overseer_tasks_exec_remoteHarvest', 'tasks.exec.remoteHarvest');
const execMineralTask = profRequire('managers_overseer_tasks_exec_mineral', 'tasks.exec.mineral');
const execTransferTask = profRequire('managers_overseer_tasks_exec_transfer', 'tasks.exec.transfer');
const execRemoteHaulTask = profRequire('managers_overseer_tasks_exec_remoteHaul', 'tasks.exec.remoteHaul');
const execRemoteBuildTask = profRequire('managers_overseer_tasks_exec_remoteBuild', 'tasks.exec.remoteBuild');
const execRemoteRepairTask = profRequire('managers_overseer_tasks_exec_remoteRepair', 'tasks.exec.remoteRepair');
const execRemoteMove2FlagTask = profRequire('managers_overseer_tasks_exec_remoteMove2Flag', 'tasks.exec.remoteMove2Flag');
const execDecongestTask = profRequire('managers_overseer_tasks_exec_decongest', 'tasks.exec.decongest');
const execDismantleTask = profRequire('managers_overseer_tasks_exec_dismantle', 'tasks.exec.dismantle');
const execReserveTask = profRequire('managers_overseer_tasks_exec_reserve', 'tasks.exec.reserve');
const execClaimTask = profRequire('managers_overseer_tasks_exec_claim', 'tasks.exec.claim');
const execScoutTask = profRequire('managers_overseer_tasks_exec_scout', 'tasks.exec.scout');
const missionBoard = profRequire('managers_overseer_missions_board_missionBoard', 'missions.board');



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
    shouldDebugLogisticsSupply: function() {
        return !!(Memory && Memory.debugLogisticsSupply === true);
    },

    isSupplyExtensionOrSpawnMission: function(mission) {
        if (!mission || mission.type !== 'transfer') return false;
        if (!mission.data || mission.data.mode !== 'supply') return false;
        if (!mission.targetId) return false;
        const target = Game.getObjectById(mission.targetId);
        if (!target) return false;
        return target.structureType === STRUCTURE_EXTENSION || target.structureType === STRUCTURE_SPAWN;
    },

    getMissionNeeds: function(mission) {
        // Cache on the mission object for this tick only.
        if (mission && mission._needsTick === Game.time && mission._needs) return mission._needs;

        const type = mission ? mission.type : null;
        const needs = { work: false, carry: false, claim: false };

        if (type === 'harvest' || type === 'remote_harvest' || type === 'mineral' || type === 'dismantle') {
            needs.work = true;
        } else if (
            type === 'upgrade' || type === 'build' || type === 'repair' ||
            type === 'remote_build' || type === 'remote_repair'
        ) {
            needs.work = true;
            needs.carry = true;
        } else if (type === 'transfer' || type === 'remote_haul') {
            needs.carry = true;
        } else if (type === 'remote_reserve' || type === 'remote_claim') {
            needs.claim = true;
        }

        mission._needsTick = Game.time;
        mission._needs = needs;
        return needs;
    },

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

    getMissionContractId: function(homeRoom, role, missionName) {
        if (!homeRoom || !role || !missionName) return null;
        return `home=${homeRoom}|role=${role}|bind=mission:${missionName}`;
    },

    isCoreLaneAssigned: function(creep) {
        if (!creep || !creep.memory) return false;
        return creep.memory.missionType === 'logisticsCoreV2' || !!creep.memory.coreLaneMissionId;
    },

    isMiningLaneAssigned: function(creep) {
        if (!creep || !creep.memory) return false;
        if (creep.memory.role === 'miningLaneHauler') return true;
        return creep.memory.missionType === 'logisticsMiningV2' || !!creep.memory.miningLaneMissionId;
    },

    clearCoreLaneAssignment: function(creep) {
        if (!creep || !creep.memory) return;
        if (creep.memory.coreLanePrevRole) {
            creep.memory.role = creep.memory.coreLanePrevRole;
        }
        delete creep.memory.coreLaneMissionId;
        delete creep.memory.missionType;
        delete creep.memory.missionId;
        delete creep.memory.coreLaneState;
        delete creep.memory.coreLanePrevRole;
        delete creep.memory.coreLaneJobId;
        delete creep.memory.coreLaneMode;
        delete creep.memory.coreLaneResourceType;
    },

    bindCoreLaneMission: function(creep, mission) {
        if (!creep || !mission || !creep.memory) return;
        if (!creep.memory.coreLanePrevRole) {
            creep.memory.coreLanePrevRole = creep.memory.role || 'hauler';
        }
        creep.memory.coreLaneMissionId = mission.id;
        creep.memory.missionType = 'logisticsCoreV2';
        creep.memory.missionId = mission.id;
        creep.memory.role = 'coreLaneHauler';
        creep.memory.coreLaneState = creep.memory.coreLaneState || 'LOAD';
        delete creep.memory.missionName;
        delete creep.memory.task;
        delete creep.memory.taskState;
        delete creep.memory.scout;
    },

    findCoreLaneCandidate: function(room, creeps) {
        // Legacy hook kept for compatibility; core lane no longer steals generic creeps.
        return null;
    },

    assignCoreLaneMission: function(room, allOwnedCreeps) {
        if (!room || !Array.isArray(allOwnedCreeps)) return;
        const coreMissions = missionBoard.listLiveByRoom(room.name).filter(m => m && m.type === 'logisticsCoreV2');
        if (coreMissions.length <= 0) {
            for (let i = 0; i < allOwnedCreeps.length; i++) {
                const creep = allOwnedCreeps[i];
                if (!creep || !creep.memory) continue;
                if (!this.isCoreLaneAssigned(creep) && creep.memory.role !== 'coreLaneHauler') continue;
                this.clearCoreLaneAssignment(creep);
                delete creep.memory.missionName;
            }
            return;
        }

        const mission = coreMissions[0];
        const contractName = mission.meta && mission.meta.missionName ? mission.meta.missionName : null;
        const desiredCount = 1;
        const assigned = allOwnedCreeps.filter(c =>
            c && c.my && c.memory &&
            c.memory.missionType === 'logisticsCoreV2' &&
            (c.memory.coreLaneMissionId === mission.id || c.memory.missionId === mission.id)
        );
        const awaitingBind = allOwnedCreeps.filter(c =>
            c && c.my && c.memory &&
            c.memory.role === 'coreLaneHauler' &&
            !this.isCoreLaneAssigned(c) &&
            contractName &&
            c.memory.missionName === contractName
        );
        const stuckInParking = allOwnedCreeps.filter(c =>
            c && c.my && c.memory &&
            c.memory.role === 'coreLaneHauler' &&
            !this.isCoreLaneAssigned(c) &&
            c.memory.missionName === 'decongest:parking'
        );

        if (assigned.length > desiredCount) {
            for (let i = desiredCount; i < assigned.length; i++) this.clearCoreLaneAssignment(assigned[i]);
        }

        let bound = assigned.length;
        for (let i = 0; i < awaitingBind.length && bound < desiredCount; i++) {
            this.bindCoreLaneMission(awaitingBind[i], mission);
            bound++;
        }

        // Reclaim core-lane haulers that drifted into parking decongest.
        for (let i = 0; i < stuckInParking.length && bound < desiredCount; i++) {
            delete stuckInParking[i].memory.missionName;
            delete stuckInParking[i].memory.task;
            delete stuckInParking[i].memory.taskState;
            this.bindCoreLaneMission(stuckInParking[i], mission);
            bound++;
        }

        // Core lane is now first-class spawn-managed; avoid stealing unrelated creeps.
        if (bound >= desiredCount) return;

        // Optional fallback: bind idle coreLaneHauler that lost missionName but is still local.
        const looseCoreLane = allOwnedCreeps.filter(c =>
            c && c.my && c.memory &&
            c.memory.role === 'coreLaneHauler' &&
            !this.isCoreLaneAssigned(c) &&
            !c.memory.missionName &&
            c.room && c.room.name === room.name
        );
        for (let i = 0; i < looseCoreLane.length && bound < desiredCount; i++) {
            this.bindCoreLaneMission(looseCoreLane[i], mission);
            bound++;
        }
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
        const allOwnedCreeps = localCreeps.concat(remote.assigned || [], remote.idle || []);
        this.assignCoreLaneMission(room, allOwnedCreeps);

        const managedLocalCreeps = localCreeps.filter(c => !this.isCoreLaneAssigned(c) && !this.isMiningLaneAssigned(c));
        const managedRemoteAssigned = (remote.assigned || []).filter(c => !this.isCoreLaneAssigned(c) && !this.isMiningLaneAssigned(c));
        const managedRemoteIdle = (remote.idle || []).filter(c => !this.isCoreLaneAssigned(c) && !this.isMiningLaneAssigned(c));
        const creeps = managedLocalCreeps.concat(managedRemoteAssigned);

        // 2. Track Mission Assignments
        // We need to know how many resources (creeps/parts) are currently assigned to each mission
        // to decide if we need to assign more.
        const missionStatus = {};
        missions.forEach(m => {
            missionStatus[m.name] = {
                mission: m,
                assignedCount: 0,
                assignedWorkParts: 0,
                assignedCarryParts: 0,
                assignedClaimParts: 0
            };
        });

        // 3. Validate and Count Existing Assignments
        creeps.forEach(creep => {
            // We count spawning creeps to prevent overcrowding (double assignment)
            if (creep.spawning) return;

            // spawnRoom is only needed while returning from remote spawn.
            // Once home, clear it to keep creep memory small.
            if (
                creep.memory &&
                creep.memory.spawnRoom &&
                creep.memory.room &&
                creep.room &&
                creep.room.name === creep.memory.room
            ) {
                delete creep.memory.spawnRoom;
            }

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
                            //creep.say('home');
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
                        //creep.say('role');
                        return;
                    }
                    if (missionStatus[missionName].mission.type === 'remote_haul' && creep.memory.role === 'remote_hauler') {
                        const migratedContractId = this.getMissionContractId(
                            creep.memory.room,
                            creep.memory.role,
                            missionName
                        );
                        if (migratedContractId) {
                            creep.memory.contractId = migratedContractId;
                            creep.memory.bindMode = 'mission';
                            creep.memory.bindId = missionName;
                        }
                    }
                    // Update status
                    missionStatus[missionName].assignedCount++;
                    
                    // Pre-cache creep body parts to be used later
                    const p = this.getCreepActiveParts(creep);
                    missionStatus[missionName].assignedWorkParts += p.work;
                    missionStatus[missionName].assignedCarryParts += p.carry;
                    missionStatus[missionName].assignedClaimParts += p.claim;
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

        const hasHigherPriorityUnderfilledMission = (priorityFloor, excludeNames) => {
            for (const name in missionStatus) {
                if (excludeNames && excludeNames.has(name)) continue;
                const st = missionStatus[name];
                const m = st.mission;
                const pr = m.priority || 0;
                if (pr <= priorityFloor) continue;

                if (this.isMissionUnderfilled(st)) {
                    return true;
                }
            }
            return false;
        };

        const clearMissionAssignment = (creep) => {
            delete creep.memory.missionName;
            delete creep.memory.taskState;
            delete creep.memory.task;
            delete creep.memory.scout;
        };

        // --- Preempt idle:upgrade when real work is underfilled ---
        const idleUpName = 'idle:upgrade';
        const idleUp = missionStatus[idleUpName] ? missionStatus[idleUpName].mission : null;
        const idlePriority = idleUp ? (idleUp.priority || 0) : -99999;

        if (idleUp && hasHigherPriorityUnderfilledMission(idlePriority, new Set([idleUpName]))) {
            // Unassign idle upgraders so they can be reassigned this tick
            creeps.forEach(creep => {
                if (creep.spawning) return;
                if (creep.memory.missionName !== idleUpName) return;
                clearMissionAssignment(creep);
            });
        }

        // --- Preempt regular upgrade missions when higher-priority work is underfilled ---
        const preemptibleUpgradeMissionNames = new Set(
            Object.keys(missionStatus).filter(name => {
                if (name === idleUpName) return false;
                const m = missionStatus[name].mission;
                return m && m.type === 'upgrade';
            })
        );

        if (preemptibleUpgradeMissionNames.size > 0) {
            let shouldPreemptUpgrades = false;
            for (const name of preemptibleUpgradeMissionNames) {
                const mission = missionStatus[name].mission;
                const priority = mission ? (mission.priority || 0) : 0;
                if (hasHigherPriorityUnderfilledMission(priority, preemptibleUpgradeMissionNames)) {
                    shouldPreemptUpgrades = true;
                    break;
                }
            }

            if (shouldPreemptUpgrades) {
                creeps.forEach(creep => {
                    if (creep.spawning) return;
                    const missionName = creep.memory.missionName;
                    if (!missionName || !preemptibleUpgradeMissionNames.has(missionName)) return;
                    clearMissionAssignment(creep);
                });
            }
        }

        // 4. Assign Idle Creeps
        const localIdle = managedLocalCreeps.filter(c => !c.spawning && !c.memory.missionName);
        const remoteIdle = managedRemoteIdle.filter(c => !c.spawning && !c.memory.missionName);
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
                if (this.shouldDebugLogisticsSupply() && creep.memory.role === 'hauler' && this.isSupplyExtensionOrSpawnMission(bestMission)) {
                    const target = bestMission.targetId ? Game.getObjectById(bestMission.targetId) : null;
                    const free = target && target.store && typeof target.store.getFreeCapacity === 'function'
                        ? target.store.getFreeCapacity(RESOURCE_ENERGY)
                        : null;
                    console.log(
                        `[LogisticsSupply][Assign] tick=${Game.time} creep=${creep.name} mission=${bestMission.name}` +
                        ` target=${bestMission.targetId} type=${target && target.structureType ? target.structureType : '-'} free=${free !== null ? free : '-'}`
                    );
                }
                if (bestMission.type === 'remote_haul' && creep.memory.role === 'remote_hauler') {
                    const missionContractId = this.getMissionContractId(
                        creep.memory.room,
                        creep.memory.role,
                        bestMission.name
                    );
                    if (missionContractId) {
                        creep.memory.contractId = missionContractId;
                        creep.memory.bindMode = 'mission';
                        creep.memory.bindId = bestMission.name;
                    }
                }
                
                // Update status immediately so next creep in this loop sees updated counts
                missionStatus[bestMission.name].assignedCount++;
                // Pre-cache creep body parts to be used later
                const p = this.getCreepActiveParts(creep);
                missionStatus[bestMission.name].assignedWorkParts += p.work;
                missionStatus[bestMission.name].assignedCarryParts += p.carry;
                missionStatus[bestMission.name].assignedClaimParts += p.claim;
                
                //creep.say(bestMission.type);
                if (creep.memory.idleTicks) delete creep.memory.idleTicks;
            } else if (this.shouldDebugLogisticsSupply() && creep.memory.role === 'hauler') {
                console.log(
                    `[LogisticsSupply][Assign] tick=${Game.time} creep=${creep.name} no_mission energy=${creep.store[RESOURCE_ENERGY] || 0} room=${creep.room && creep.room.name ? creep.room.name : '-'}`
                );
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
                            //creep.say('recycle');
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
        room._towerAlloc = { needs: Object.create(null), objects: Object.create(null) };
        const towers = cache.myStructuresByType[STRUCTURE_TOWER] || [];
        towers.forEach(tower => {
            const bestMission = this.findBestTowerMission(tower, missionsSorted);
            if (bestMission) {
                this.assignTowerAction(tower, bestMission, room, room._towerAlloc);
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

            // Keep logistics core v2 haulers out of parking decongest.
            if (m.name === 'decongest:parking' && creep.memory.role === 'coreLaneHauler') continue;

            const home = creep.memory.room;
            const awayFromHome = home && creep.room && creep.room.name !== home;
            if (awayFromHome && !this.isRemoteMission(m, home)) continue;

            const status = missionStatus[m.name];
            if (!status) continue;
            const req = m.requirements || {};

            // Check archetype match if specified
            if (req.archetype && req.archetype !== creep.memory.role) continue;
            // Cache once per creep per tick
            const parts = this.getCreepActiveParts(creep);

            // Check if creep is capable for this mission type
            const needs = this.getMissionNeeds(m); // {work, carry, claim}

            if (needs.work && parts.work === 0) continue;
            if (needs.carry && parts.carry === 0) continue;
            if (needs.claim && parts.claim === 0) continue;

            // Hard cap if mission requested max population.
            const maxCount = Number.isFinite(req.maxCount) ? req.maxCount : null;
            if (maxCount !== null && status.assignedCount >= maxCount) continue;

            // Skip already-satisfied missions.
            if (!this.isMissionUnderfilled(status)) continue;

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

    isMissionUnderfilled: function(status) {
        if (!status || !status.mission) return false;
        const req = status.mission.requirements || {};
        const minCount = Number.isFinite(req.minCount) ? req.minCount : 0;
        const requiredWork = Number.isFinite(req.requiredWork) ? req.requiredWork : 0;
        const requiredCarry = Number.isFinite(req.requiredCarry) ? req.requiredCarry : 0;
        const requiredClaim = Number.isFinite(req.requiredClaim) ? req.requiredClaim : 0;
        const maxCount = Number.isFinite(req.maxCount) ? req.maxCount : null;
        const hasDemandFloor = minCount > 0 || requiredWork > 0 || requiredCarry > 0 || requiredClaim > 0;

        if (maxCount !== null && status.assignedCount >= maxCount) return false;
        if (status.assignedCount < minCount) return true;
        if (status.assignedWorkParts < requiredWork) return true;
        if (status.assignedCarryParts < requiredCarry) return true;
        if (status.assignedClaimParts < requiredClaim) return true;
        if (!hasDemandFloor && maxCount !== null && status.assignedCount < maxCount) return true;
        return false;
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
            case 'move2flag':
                task = execRemoteMove2FlagTask({ creep, mission, room});
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

        // Telegraph what the creep intends to do (throttled to avoid spam).
        //this.telegraphCreep(creep, mission, legacyTask);
    },

    assignTowerAction: function(tower, mission, room, allocCtx) {
        let action = null;
        let targetId = null;

        if (mission.type === 'tower_attack') {
            action = 'attack';
            targetId = this.findBestTarget(tower, mission, action, allocCtx);
        } else if (mission.type === 'tower_heal') {
            action = 'heal';
            targetId = this.findBestTarget(tower, mission, action, allocCtx);
        } else if (mission.type === 'tower_repair') {
            action = 'repair';
            targetId = this.findBestTarget(tower, mission, action, allocCtx);
        }

        if (action && targetId) {
            room._towerTasks[tower.id] = { action, targetId };
        }
    },

    getTowerEffectAtRange: function(action, range) {
        const optimal = Number.isFinite(global.TOWER_OPTIMAL_RANGE) ? global.TOWER_OPTIMAL_RANGE : 5;
        const falloffRange = Number.isFinite(global.TOWER_FALLOFF_RANGE) ? global.TOWER_FALLOFF_RANGE : 20;
        const falloff = Number.isFinite(global.TOWER_FALLOFF) ? global.TOWER_FALLOFF : 0.75;

        const base =
            action === 'heal'
                ? (Number.isFinite(global.TOWER_POWER_HEAL) ? global.TOWER_POWER_HEAL : 400)
                : action === 'repair'
                    ? (Number.isFinite(global.TOWER_POWER_REPAIR) ? global.TOWER_POWER_REPAIR : 800)
                    : (Number.isFinite(global.TOWER_POWER_ATTACK) ? global.TOWER_POWER_ATTACK : 600);

        const clamped = Math.max(1, Math.min(Number.isFinite(range) ? range : falloffRange, 50));
        if (clamped <= optimal) return base;
        if (clamped >= falloffRange) return base * (1 - falloff);
        const ratio = (clamped - optimal) / Math.max(1, (falloffRange - optimal));
        return base * (1 - (falloff * ratio));
    },

    findBestTarget: function(tower, mission, action, allocCtx) {
        const targetIds = mission && mission.targetIds;
        if (!targetIds || targetIds.length === 0) return null;
        const targets = targetIds.map(id => {
            if (allocCtx && allocCtx.objects && allocCtx.objects[id] !== undefined) return allocCtx.objects[id];
            const obj = this.getCachedObject(tower.room, id);
            if (allocCtx && allocCtx.objects) allocCtx.objects[id] = obj || null;
            return obj;
        }).filter(t => t);
        if (targets.length === 0) return null;

        if (action === 'heal' || action === 'repair') {
            const missionKey = `${action}:${mission.name || 'anon'}`;
            let needs = allocCtx && allocCtx.needs ? allocCtx.needs[missionKey] : null;
            if (!needs) {
                needs = Object.create(null);
                for (const t of targets) {
                    const deficit = (t && Number.isFinite(t.hitsMax) && Number.isFinite(t.hits))
                        ? Math.max(0, t.hitsMax - t.hits)
                        : 0;
                    needs[t.id] = deficit;
                }
                if (allocCtx && allocCtx.needs) allocCtx.needs[missionKey] = needs;
            }

            let best = null;
            let bestRange = Infinity;
            for (const t of targets) {
                if ((needs[t.id] || 0) <= 0) continue;
                const range = tower.pos.getRangeTo(t.pos);
                if (range < bestRange) {
                    best = t;
                    bestRange = range;
                }
            }

            if (!best) {
                return null;
            }

            const effect = this.getTowerEffectAtRange(action, bestRange);
            needs[best.id] = Math.max(0, (needs[best.id] || 0) - effect);
            return best.id;
        }

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

    getCreepActiveParts: function(creep) {
        // Cache per-creep per-tick. Ephemeral only.
        if (creep._partsTick === Game.time && creep._parts) return creep._parts;

        // Only compute what this file uses for gating + missionStatus accounting.
        const parts = {
            work: creep.getActiveBodyparts(WORK),
            carry: creep.getActiveBodyparts(CARRY),
            claim: creep.getActiveBodyparts(CLAIM),
        };

        creep._partsTick = Game.time;
        creep._parts = parts;
        return parts;
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


    // --- Fun stuff --------------------- it's a game afterall ---- 
    // --- Smart Ant Labor Flavor ---
    getAntPhrase: function(creep, mission, action) {
        const m = mission && mission.type;
        const role = creep && creep.memory && creep.memory.role;

        const byMission = {
            harvest: [
                "dig fast ⛏",
                "mine mine ⛏",
                "ants dig 🐜",
                "rock pls 🪨"
            ],
            remote_harvest: [
                "far dig 😩",
                "long walk 🚶",
                "no wifi 📡",
                "remote job 🌍"
            ],
            upgrade: [
                "big brain 🧠",
                "lvl up ⚡",
                "brain food ⚡",
                "smart ant 🐜"
            ],
            build: [
                "buildy 🚧",
                "lego time 🧱",
                "more wall 🧱",
                "stack pls 📦"
            ],
            repair: [
                "fix it 🩹",
                "who broke 😑",
                "tape job 🩹",
                "glue pls 🧴"
            ],
            dismantle: [
                "break it 🔨",
                "smash pls 💥",
                "no wall 🗿",
                "rip base 😈"
            ],
            transfer: [
                "haul it 📦",
                "heavy bro 💪",
                "stack E ⚡",
                "carry pls 🐜"
            ],
            remote_haul: [
                "far haul 😭",
                "road trip 🚚",
                "heavy trip 💪",
                "long carry 🐜"
            ]
        };

        const byRole = {
            upgrader: [
                "brain ant 🧠",
                "smart job ⚡"
            ],
            repairer: [
                "fix squad 🩹"
            ],
            remote_worker: [
                "exile ant 😩"
            ],
            hauler: [
                "muscle ant 💪"
            ]
        };

        const generic = [
            "ant job 🐜",
            "for queen 👑",
            "no rest 😤",
            "tiny boss 👀",
            "payday? 💰",
            "ant life 🐜"
        ];

        let pool = null;

        if (m && byMission[m]) {
            pool = byMission[m];
        } else if (role && byRole[role]) {
            pool = byRole[role];
        } else {
            pool = generic;
        }

        return pool[Math.floor(Math.random() * pool.length)];
    },


    // ---- Creep telegraphing via creep.say ----
    // Enable/disable by setting: global.TASK_TELEGRAPH = true/false
    // Throttling is handled per-creep to keep console readable.
    telegraphCreep: function(creep, mission, legacyTask) {
        try {
            // Default ON unless explicitly disabled.
            if (global && global.TASK_TELEGRAPH === false) return;
            if (!creep || creep.spawning) return;

            const action = legacyTask && (legacyTask.action || legacyTask.type);
            if (!action) return;

            // Throttle: only say when message changes, or every N ticks.
            const EVERY = (global && Number.isFinite(global.TASK_TELEGRAPH_EVERY)) ? global.TASK_TELEGRAPH_EVERY : 15;

            const msg = this.formatTelegraph(creep, mission, legacyTask);
            if (!msg) return;

            const mem = creep.memory || (creep.memory = {});
            const last = mem._telegraph || {};
            const changed = last.msg !== msg;
            const due = !last.t || (Game.time - last.t) >= EVERY;

            if (changed || due) {
                creep.say(msg, true);
                mem._telegraph = { msg, t: Game.time };
            }
        } catch (e) {
            // Never let say logic break tasking.
        }
    },

    formatTelegraph: function(creep, mission, legacyTask) {
        const action = legacyTask && (legacyTask.action || legacyTask.type);
        if (!action) return null;

        // Random fun ant chatter (low chance)
        const FUN_CHANCE = 0.05; // 15%

        if (Math.random() < FUN_CHANCE) {
            return this.getAntPhrase(creep, mission, action);
        }

        // Compact icons (fallbacks are short ASCII to avoid weird font widths).
        const icon = (a) => {
            switch (a) {
                case 'move': return '➡';
                case 'withdraw': return '⇣';
                case 'transfer': return '⇡';
                case 'harvest': return '⛏';
                case 'build': return '🚧';
                case 'repair': return '🩹';
                case 'upgrade': return '⚡';
                case 'pickup': return '📦';
                case 'dismantle': return '🔨';
                case 'reserve': return '📌';
                case 'claim': return '👑';
                case 'drop': return '⬇';
                default: return null;
            }
        };

        const short = (a) => {
            switch (a) {
                case 'move': return 'mv';
                case 'withdraw': return 'wd';
                case 'transfer': return 'tr';
                case 'harvest': return 'hv';
                case 'build': return 'bu';
                case 'repair': return 'rp';
                case 'upgrade': return 'up';
                case 'pickup': return 'pk';
                case 'dismantle': return 'ds';
                case 'reserve': return 'rs';
                case 'claim': return 'cl';
                case 'drop': return 'dr';
                default: return 'do';
            }
        };

        // Prefer icons if they exist; otherwise ASCII.
        let msg = icon(action) || short(action);

        // Optional: show resource hint for logistics actions.
        if ((action === 'withdraw' || action === 'transfer' || action === 'pickup' || action === 'drop') && legacyTask.resourceType) {
            // Single-letter-ish resource hint.
            const r = legacyTask.resourceType;
            if (r === RESOURCE_ENERGY) msg += 'E';
            else if (typeof r === 'string' && r.length > 0) msg += r[0].toUpperCase();
        }

        // Optional: show mission hint when action is just moving (so we know *why* we're moving).
        if (action === 'move' && mission && mission.type) {
            // 1-char-ish mission hint to avoid huge bubbles.
            const m = mission.type;
            const hint =
                (m === 'upgrade') ? 'U' :
                (m === 'build' || m === 'remote_build') ? 'B' :
                (m === 'repair' || m === 'remote_repair') ? 'R' :
                (m === 'transfer' || m === 'remote_haul') ? 'T' :
                (m === 'harvest' || m === 'remote_harvest' || m === 'mineral') ? 'H' :
                (m === 'dismantle') ? 'D' :
                (m === 'remote_reserve') ? 'V' :
                (m === 'remote_claim') ? 'C' :
                null;
            if (hint) msg += hint;
        }

        return msg;
    },

};

module.exports = managerTasks;

