var managerMission = {
    run: function() {
        // Initialize Memory
        if (!Memory.missionControl) Memory.missionControl = {};
        if (!Memory.missionControl.squads) Memory.missionControl.squads = {};
        
        this.detectCombatMission();
        this.detectReserverMission();
        this.detectClaimerMission();
        this.detectBootstrapMission();
        this.detectMovingHouseMission();
        this.detectDismantleMission();
        this.detectRemoteMiningMission();
    },

    detectCombatMission: function() {
        if (Game.flags['FlagRallyDefender']) {
            var isNewFlag = !Memory.missionControl.squads.alpha || 
                            !Memory.missionControl.squads.alpha.flag_old_exist;

            this.runCombatMission(isNewFlag ? 1 : 0);

            if (Memory.missionControl.squads.alpha) {
                Memory.missionControl.squads.alpha.flag_old_exist = 1;
            }
        } else {
            if (Memory.missionControl.squads.alpha) {
                delete Memory.missionControl.squads.alpha;
            }
        }
    },

    detectReserverMission: function() {
        if (!Memory.missionControl.squads.reserver) {
            Memory.missionControl.squads.reserver = {};
        }
        
        // Migration: If old structure (active property exists on root), reset
        if (Memory.missionControl.squads.reserver.active !== undefined) {
            Memory.missionControl.squads.reserver = {};
        }

        const flags = _.filter(Game.flags, (f) => f.name.startsWith('FlagReserver'));

        for (let flagName in Memory.missionControl.squads.reserver) {
            if (!Game.flags[flagName]) {
                delete Memory.missionControl.squads.reserver[flagName];
            }
        }

        for (let flag of flags) {
            this.runReserverMission(flag);
        }
    },

    detectClaimerMission: function() {
        if (Game.flags['FlagClaimer']) {
            var isNewFlag = !Memory.missionControl.squads.claimer || 
                            !Memory.missionControl.squads.claimer.flag_old_exist;
            this.runClaimerMission(isNewFlag);
            if (Memory.missionControl.squads.claimer) {
                Memory.missionControl.squads.claimer.flag_old_exist = 1;
            }
        } else {
            if (Memory.missionControl.squads.claimer) {
                delete Memory.missionControl.squads.claimer;
            }
        }
    },

    detectBootstrapMission: function() {
        if (Game.flags['FlagBootstrap']) {
            this.runBootstrapMission();
        } else {
            if (Memory.missionControl.squads.bootstrap) {
                delete Memory.missionControl.squads.bootstrap;
            }
        }
    },

    detectMovingHouseMission: function() {
        if (Game.flags['FlagBank'] && Game.flags['FlagSink']) {
            this.runMovingHouseMission();
        } else {
            if (Memory.missionControl.squads.movinghouse) {
                delete Memory.missionControl.squads.movinghouse;
            }
        }
    },

    detectDismantleMission: function() {
        if (Game.flags['FlagDismantle']) {
            this.runDismantleMission();
        } else {
            if (Memory.missionControl.squads.dismantle) {
                delete Memory.missionControl.squads.dismantle;
            }
        }
    },

    detectRemoteMiningMission: function() {
        if (!Memory.missionControl.squads.remoteMining) {
            Memory.missionControl.squads.remoteMining = {};
        }
        
        // Find all flags starting with FlagRMining
        const flags = _.filter(Game.flags, (f) => f.name.startsWith('FlagRMining'));
        
        // Cleanup old missions
        for (let flagName in Memory.missionControl.squads.remoteMining) {
            if (!Game.flags[flagName]) {
                delete Memory.missionControl.squads.remoteMining[flagName];
            }
        }

        for (let flag of flags) {
            this.runRemoteMiningMission(flag);
        }
    },


    runCombatMission: function(reinit_timer) {
        // Define Squad Alpha
        if (!Memory.missionControl.squads.alpha) {
            Memory.missionControl.squads.alpha = {
                state: 'idle', // 'idle', 'assembling', 'attacking'
                targetSize: { defender: 1, healer: 0 , tank: 0},
                bodies: {
                    defender: [RANGED_ATTACK, MOVE],
                    healer: [HEAL, MOVE],
                    tank: [TOUGH, MOVE, ATTACK]
                },
                spawnRoom: '',
                lastLaunch: Game.time,
                launchInterval: 100 // Ticks between waves
            };
        }

        var squad = Memory.missionControl.squads.alpha;
        // Ensure properties exist for existing memory
        if (squad.lastLaunch === undefined) squad.lastLaunch = Game.time;
        if (squad.launchInterval === undefined) squad.launchInterval = 100;
        if (squad.spawnRoom === undefined) squad.spawnRoom = '';
        if (!squad.bodies) {
            squad.bodies = {
                defender: [RANGED_ATTACK, MOVE],
                healer: [HEAL, MOVE],
                tank: [TOUGH, MOVE, ATTACK]
            };
        }

        var assemblyFlag = Game.flags['FlagAssembly'];
        var rallyFlag = Game.flags['FlagRallyDefender'];

        // Auto-assign spawn room if not set or invalid
        if (assemblyFlag && (!squad.spawnRoom || !Game.rooms[squad.spawnRoom] || !Game.rooms[squad.spawnRoom].controller.my)) {
            let bestRoom = null;
            let minDistance = Infinity;

            for (let roomName in Game.rooms) {
                let room = Game.rooms[roomName];
                if (room.controller && room.controller.my && room.find(FIND_MY_SPAWNS).length > 0) {
                    let dist = Game.map.getRoomLinearDistance(roomName, assemblyFlag.pos.roomName);
                    if (dist < minDistance) {
                        minDistance = dist;
                        bestRoom = roomName;
                    }
                }
            }

            if (bestRoom) {
                squad.spawnRoom = bestRoom;
                log(`Squad Alpha: Assigned spawn room to ${bestRoom} (Distance: ${minDistance})`);
            }
        }
        
        // Get current alive unit counts
        var defenders = _.filter(Game.creeps, (c) => c.memory.role == 'mission_defender_range');
        var healers = _.filter(Game.creeps, (c) => c.memory.role == 'mission_range_healer');
        var tank = _.filter(Game.creeps, (c) => c.memory.role == 'mission_defender_tank');

        // --- State Machine ---
        
        if (squad.state == 'idle') {
            // Check time interval to launch new wave
            // Threat Assessment & Body Composition
            if (rallyFlag) {
                const targetRoom = Game.rooms[rallyFlag.pos.roomName];
                if (targetRoom) {
                    const hostiles = targetRoom.find(FIND_HOSTILE_CREEPS);
                    const towers = targetRoom.find(FIND_HOSTILE_STRUCTURES, {filter: s => s.structureType == STRUCTURE_TOWER});
                    const invaderCores = targetRoom.find(FIND_HOSTILE_STRUCTURES, {filter: (s) => s.structureType == STRUCTURE_INVADER_CORE});

                    let enemyAttackParts = 0;
                    let enemyRangedParts = 0;
                    
                    hostiles.forEach(c => {
                        enemyAttackParts += c.getActiveBodyparts(ATTACK);
                        enemyRangedParts += c.getActiveBodyparts(RANGED_ATTACK);
                    });

                    // Determine Composition based on threat
                    if (towers.length > 0) {
                        // Anti-Tower Squad: Needs Healers and Tanks
                        squad.targetSize = { defender: 2, healer: 2, tank: 1 };
                        squad.bodies.tank = [TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, MOVE, MOVE, MOVE, MOVE, MOVE, ATTACK]; 
                        squad.bodies.healer = [HEAL, HEAL, HEAL, MOVE, MOVE, MOVE];
                        squad.bodies.defender = [RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE];
                    } else if (enemyAttackParts + enemyRangedParts > 10) {
                        // Heavy Combat Squad
                        squad.targetSize = { defender: 3, healer: 2, tank: 0 };
                        squad.bodies.defender = [RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE];
                        squad.bodies.healer = [HEAL, HEAL, MOVE, MOVE];
                    } else if (invaderCores.length > 0) {
                        // Slightly higher firepower squad
                        squad.targetSize = { defender: 0, healer: 0, tank: 2 };
                        squad.bodies.defender = [ATTACK, ATTACK, ATTACK, MOVE, MOVE];
                    }
                    else {
                        // Standard Patrol
                        squad.targetSize = { defender: 2, healer: 0, tank: 0 };
                        squad.bodies.defender = [RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE];
                    }
                }
            }

            if (Game.time - squad.lastLaunch > squad.launchInterval || reinit_timer == 1) {
                squad.state = 'assembling';
                squad.lastLaunch = Game.time;
                log('Squad Alpha: Launch interval reached. Commencing assembly.');
            }
        } else if (squad.state == 'assembling') {
            // Check if roster is full
            if (defenders.length >= squad.targetSize.defender && 
                healers.length >= squad.targetSize.healer && 
                tank.length >= squad.targetSize.tank) {
                
                // Optional: Check if they are physically gathered near the flag (e.g. within 10 tiles)
                // This prevents the squad from launching while the last member is still spawning
                var allGathered = true;
                if (assemblyFlag) {
                    var allCreeps = defenders.concat(healers);
                    allCreeps = allCreeps.concat(tank);
                    for (var c of allCreeps) {
                        if (!c.pos.inRangeTo(assemblyFlag, 4)) {
                            allGathered = false;
                            break;
                        }
                    }
                }

                if (allGathered) {
                    squad.state = 'attacking';
                    squad.targetId = null; // Initialize shared target
                    log('Squad Alpha: All units assembled and ready. Commencing attack!');
                }
            }
        } else if (squad.state == 'attacking') {
            // If squad is wiped out (or drops below critical mass), reset to idle
            if (defenders.length == 0 && healers.length == 0) {
                delete squad.targetId;
                squad.state = 'idle';
                log('Squad Alpha: Unit wiped out. Resetting to idle.');
            }
        }
        
        // Visual Status
        if (assemblyFlag && squad.state == 'assembling') {
            new RoomVisual(assemblyFlag.pos.roomName).text(
                `Assembling: ${defenders.length}/${squad.targetSize.defender} Def, ${healers.length}/${squad.targetSize.healer} Heal, ${tank.length}/${squad.targetSize.tank} Tank`,
                assemblyFlag.pos.x, assemblyFlag.pos.y + 2, 
                {align: 'center', color: 'yellow', font: 0.5}
            );
        } else if (assemblyFlag && squad.state == 'idle') {
            let ticksNext = (squad.lastLaunch + squad.launchInterval) - Game.time;
            new RoomVisual(assemblyFlag.pos.roomName).text(
                `Next Wave: ${ticksNext}`,
                assemblyFlag.pos.x, assemblyFlag.pos.y + 2, 
                {align: 'center', color: 'gray', font: 0.5}
            );
        }
    },

    runReserverMission: function(flag) {
        // Initialize Memory for Reserver Mission
        if (!Memory.missionControl.squads.reserver[flag.name]) {
            Memory.missionControl.squads.reserver[flag.name] = {
                active: false,
                spawnRoom: '',
                targetRoom: ''
            };
        }

        var mission = Memory.missionControl.squads.reserver[flag.name];

        if (flag) {
            mission.active = true;
            mission.targetRoom = flag.pos.roomName;

            // Initialize lastLaunch if not present
            if (mission.lastLaunch === undefined) mission.lastLaunch = 0;

            // Auto-assign spawn room if not set or invalid
            if (!mission.spawnRoom || !Game.rooms[mission.spawnRoom] || !Game.rooms[mission.spawnRoom].controller.my) {
                let bestRoom = null;
                let minDistance = Infinity;

                for (let roomName in Game.rooms) {
                    let room = Game.rooms[roomName];
                    if (room.controller && room.controller.my && room.find(FIND_MY_SPAWNS).length > 0) {
                        let dist = Game.map.getRoomLinearDistance(roomName, mission.targetRoom);
                        if (dist < minDistance) {
                            minDistance = dist;
                            bestRoom = roomName;
                        }
                    }
                }

                if (bestRoom) {
                    mission.spawnRoom = bestRoom;
                    log(`Reserver Mission (${flag.name}): Assigned spawn room to ${bestRoom} for target ${mission.targetRoom}`);
                }
            }
            
            // Visual Status
            new RoomVisual(flag.pos.roomName).text(
                `Reserver Target`,
                flag.pos.x, flag.pos.y + 2, 
                {align: 'center', color: 'purple', font: 0.5}
            );

        } else {
            mission.active = false;
        }
    },

    runClaimerMission: function(isNewFlag) {
        // Initialize Memory for Claimer Mission
        if (!Memory.missionControl.squads.claimer) {
            Memory.missionControl.squads.claimer = {
                active: false,
                spawnRoom: '',
                targetRoom: '',
                lastLaunch: Game.time,
            };
        }

        var mission = Memory.missionControl.squads.claimer;
        var flag = Game.flags['FlagClaimer'];

        if (flag) {
            mission.active = true;
            mission.targetRoom = flag.pos.roomName;

            // Auto-assign spawn room if not set or invalid
            if (!mission.spawnRoom || !Game.rooms[mission.spawnRoom] || !Game.rooms[mission.spawnRoom].controller.my) {
                let bestRoom = null;
                let minDistance = Infinity;

                for (let roomName in Game.rooms) {
                    let room = Game.rooms[roomName];
                    if (room.controller && room.controller.my && room.find(FIND_MY_SPAWNS).length > 0) {
                        let dist = Game.map.getRoomLinearDistance(roomName, mission.targetRoom);
                        if (dist < minDistance) {
                            minDistance = dist;
                            bestRoom = roomName;
                        }
                    }
                }

                if (bestRoom) {
                    mission.spawnRoom = bestRoom;
                    log(`Claimer Mission: Assigned spawn room to ${bestRoom} for target ${mission.targetRoom}`);
                }
            }
            
            if (isNewFlag) {
                mission.wantSpawn = true;
                log('Claimer Mission: New flag detected, triggering immediate spawn.');
            }
            
            // Timer Logic: Trigger spawn every 950 ticks
            if (Game.time - mission.lastLaunch >= 950) {
                mission.wantSpawn = true;
            }

            // Visual Status
            let ticksNext = 950 - (Game.time - mission.lastLaunch);
            if (ticksNext < 0) ticksNext = 0;
            new RoomVisual(flag.pos.roomName).text(
                `Claimer Target (Next: ${ticksNext})`,
                flag.pos.x, flag.pos.y + 2, 
                {align: 'center', color: 'purple', font: 0.5}
            );

        } else {
            mission.active = false;
            mission.wantSpawn = false;
        }
    },

    runBootstrapMission: function() {
        // Initialize Memory for Bootstrap Mission
        if (!Memory.missionControl.squads.bootstrap) {
            Memory.missionControl.squads.bootstrap = {
                active: false,
                spawnRoom: '',
                targetRoom: ''
            };
        }

        var mission = Memory.missionControl.squads.bootstrap;
        var flag = Game.flags['FlagBootstrap'];

        if (flag) {
            mission.active = true;
            mission.targetRoom = flag.pos.roomName;

            // Auto-assign spawn room if not set or invalid
            if (!mission.spawnRoom || !Game.rooms[mission.spawnRoom] || !Game.rooms[mission.spawnRoom].controller.my) {
                let bestRoom = null;
                let minDistance = Infinity;

                for (let roomName in Game.rooms) {
                    let room = Game.rooms[roomName];
                    if (room.controller && room.controller.my && room.find(FIND_MY_SPAWNS).length > 0) {
                        let dist = Game.map.getRoomLinearDistance(roomName, mission.targetRoom);
                        if (dist < minDistance) {
                            minDistance = dist;
                            bestRoom = roomName;
                        }
                    }
                }

                if (bestRoom) {
                    mission.spawnRoom = bestRoom;
                    log(`Bootstrap Mission: Assigned spawn room to ${bestRoom} for target ${mission.targetRoom}`);
                }
            }
            
            // Visual Status
            new RoomVisual(flag.pos.roomName).text(
                `Bootstrap Target`,
                flag.pos.x, flag.pos.y + 2, 
                {align: 'center', color: 'green', font: 0.5}
            );

        } else {
            mission.active = false;
        }
    },

    runMovingHouseMission: function() {
        // Initialize Memory for Moving House Mission
        if (!Memory.missionControl.squads.movinghouse) {
            Memory.missionControl.squads.movinghouse = {
                active: false,
                spawnRoom: '',
                targetRoomBank: '',
                targetRoomSink: '',
                desiredAmount: 2
            };
        }

        var mission = Memory.missionControl.squads.movinghouse;
        var flagBank = Game.flags['FlagBank'];
        var flagSink = Game.flags['FlagSink'];

        if (flagBank && flagSink) {
            mission.active = true;
            mission.targetRoomBank = flagBank.pos.roomName;
            mission.targetRoomSink = flagSink.pos.roomName;
            mission.bankPos = { x: flagBank.pos.x, y: flagBank.pos.y, roomName: flagBank.pos.roomName };
            mission.sinkPos = { x: flagSink.pos.x, y: flagSink.pos.y, roomName: flagSink.pos.roomName };
            mission.desiredAmount = 2;
            mission.spawnRoom = flagBank.pos.roomName;
  
            new RoomVisual(flagBank.pos.roomName).text('Moving House Bank', flagBank.pos.x, flagBank.pos.y + 2, {align: 'center', color: 'blue', font: 0.5});
            new RoomVisual(flagSink.pos.roomName).text('Moving House Sink', flagSink.pos.x, flagSink.pos.y + 2, {align: 'center', color: 'blue', font: 0.5});
        } else {
            mission.active = false;
        }
    },

    runDismantleMission: function() {
        // Initialize Memory for Dismantle Mission
        if (!Memory.missionControl.squads.dismantle) {
            Memory.missionControl.squads.dismantle = {
                active: false,
                spawnRoom: '',
                targetRoom: ''
            };
        }

        var mission = Memory.missionControl.squads.dismantle;
        var flag = Game.flags['FlagDismantle'];

        if (flag) {
            mission.active = true;
            mission.targetRoom = flag.pos.roomName;

            // Auto-assign spawn room if not set or invalid
            if (!mission.spawnRoom || !Game.rooms[mission.spawnRoom] || !Game.rooms[mission.spawnRoom].controller.my) {
                let bestRoom = null;
                let minDistance = Infinity;

                for (let roomName in Game.rooms) {
                    let room = Game.rooms[roomName];
                    if (room.controller && room.controller.my && room.find(FIND_MY_SPAWNS).length > 0) {
                        let dist = Game.map.getRoomLinearDistance(roomName, mission.targetRoom);
                        if (dist < minDistance) {
                            minDistance = dist;
                            bestRoom = roomName;
                        }
                    }
                }

                if (bestRoom) {
                    mission.spawnRoom = bestRoom;
                    log(`Dismantle Mission: Assigned spawn room to ${bestRoom} for target ${mission.targetRoom}`);
                }
            }
            
            // Visual Status
            new RoomVisual(flag.pos.roomName).text(
                `Dismantle Target`,
                flag.pos.x, flag.pos.y + 2, 
                {align: 'center', color: 'red', font: 0.5}
            );

        } else {
            mission.active = false;
        }
    },

    runRemoteMiningMission: function(flag) {
        let mission = Memory.missionControl.squads.remoteMining[flag.name];
        if (!mission) {
            mission = {
                active: true,
                spawnRoom: '',
                targetRoom: flag.pos.roomName,
                sources: {}, // id: creepName
                haulers: {}  // id: creepName
            };
            Memory.missionControl.squads.remoteMining[flag.name] = mission;
        }

        // Ensure haulers object exists
        if (!mission.haulers) mission.haulers = {};

        // Assign Spawn Room
        if (!mission.spawnRoom || !Game.rooms[mission.spawnRoom] || !Game.rooms[mission.spawnRoom].controller.my) {
            let bestRoom = null;
            let minDistance = Infinity;

            for (let roomName in Game.rooms) {
                let room = Game.rooms[roomName];
                if (room.controller && room.controller.my && room.find(FIND_MY_SPAWNS).length > 0) {
                    let dist = Game.map.getRoomLinearDistance(roomName, mission.targetRoom);
                    if (dist < minDistance) {
                        minDistance = dist;
                        bestRoom = roomName;
                    }
                }
            }

            if (bestRoom) {
                mission.spawnRoom = bestRoom;
                log(`Remote Mining Mission (${flag.name}): Assigned spawn room to ${bestRoom} for target ${mission.targetRoom}`);
            }
        }

        // Detect Sources
        if (Object.keys(mission.sources).length === 0) {
             // Try to get from Memory.remoteRooms
             if (Memory.remoteRooms && Memory.remoteRooms[mission.targetRoom]) {
                 let sourceIds = Memory.remoteRooms[mission.targetRoom].sources;
                 for (let id of sourceIds) {
                     mission.sources[id] = null;
                 }
                 if (Memory.remoteRooms[mission.targetRoom].sourcePositions) {
                     mission.sourcePositions = Memory.remoteRooms[mission.targetRoom].sourcePositions;
                 }
             } else if (Game.rooms[mission.targetRoom]) {
                 // If visible
                 let sources = Game.rooms[mission.targetRoom].find(FIND_SOURCES);
                 let positions = [];
                 for (let s of sources) {
                     mission.sources[s.id] = null;
                     positions.push({x: s.pos.x, y: s.pos.y});
                 }
                 mission.sourcePositions = positions;
             }
        }

        // Calculate Hauler Requirements
        if (!mission.sourceDetails) mission.sourceDetails = {};
        
        if (mission.spawnRoom && Game.rooms[mission.spawnRoom]) {
            const spawnRoom = Game.rooms[mission.spawnRoom];
            const storage = spawnRoom.storage || spawnRoom.find(FIND_MY_SPAWNS)[0];
            
            if (storage) {
                for (let sourceId in mission.sources) {
                    if (!mission.sourceDetails[sourceId]) {
                        mission.sourceDetails[sourceId] = {};
                    }
                    
                    let details = mission.sourceDetails[sourceId];

                    // Calculate if not set
                    if (details.desiredHaulers === undefined) {
                        let sourcePos = null;
                        
                        // 1. Try Memory
                        if (Memory.remoteRooms && Memory.remoteRooms[mission.targetRoom]) {
                            const rr = Memory.remoteRooms[mission.targetRoom];
                            if (rr.sources && rr.sourcePositions) {
                                const idx = rr.sources.indexOf(sourceId);
                                if (idx >= 0 && rr.sourcePositions[idx]) {
                                    sourcePos = new RoomPosition(rr.sourcePositions[idx].x, rr.sourcePositions[idx].y, mission.targetRoom);
                                }
                            }
                        }
                        
                        // 2. Try Visibility
                        if (!sourcePos && Game.rooms[mission.targetRoom]) {
                            const source = Game.getObjectById(sourceId);
                            if (source) sourcePos = source.pos;
                        }

                        if (sourcePos) {
                            const ret = PathFinder.search(storage.pos, {pos: sourcePos, range: 1}, {
                                plainCost: 2,
                                swampCost: 10,
                            });

                            if (!ret.incomplete) {
                                const distance = ret.path.length;
                                details.distance = distance;

                                // Calculate Haulers: (Distance * 2 * 10 energy/tick) / CarryCapacity
                                const maxEnergy = Math.min(spawnRoom.energyCapacityAvailable, 1500);
                                const carryCapacity = Math.floor(maxEnergy / 100) * 50;
                                const needed = Math.ceil(((distance + 20) * 10) / carryCapacity);

                                details.desiredHaulers = Math.min(Math.max(needed, 1), 6); // Clamp between 1 and 6
                            }
                        }
                    }
                }
            }
        }
        
        // Visual Status
        new RoomVisual(flag.pos.roomName).text(
            `Remote Mining`,
            flag.pos.x, flag.pos.y + 2, 
            {align: 'center', color: 'yellow', font: 0.5}
        );
    },

};

module.exports = managerMission;
