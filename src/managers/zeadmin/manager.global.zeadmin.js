const heap = require('utils_heap');

const ASSAULT_WATCHDOG_DEFAULTS = {
    enabled: true,
    abortOnEarlyWipe: true,
    earlyWipeTicks: 500,
    staleTicks: 1500,
    maxEvents: 80
};

function deriveOverallState(opsState, combatState) {
    if (combatState === 'SIEGE') return 'SIEGE';
    if (combatState === 'DEFEND') return 'DEFENSE';
    if (combatState === 'CAUTION' || opsState === 'EMERGENCY') return 'WATCH';
    return 'SAFE';
}

function countMissionsByType(missions) {
    const byType = {};
    if (!Array.isArray(missions)) return byType;
    for (let i = 0; i < missions.length; i++) {
        const mission = missions[i];
        const type = mission && mission.type ? mission.type : 'unknown';
        byType[type] = (byType[type] || 0) + 1;
    }
    return byType;
}

function buildHomeCreepCounts() {
    const counts = {};
    for (const name in Game.creeps) {
        const creep = Game.creeps[name];
        if (!creep || !creep.memory) continue;
        const homeRoom = creep.memory.room;
        if (!homeRoom) continue;
        counts[homeRoom] = (counts[homeRoom] || 0) + 1;
    }
    return counts;
}

function getSeriesLast(seriesStore, key) {
    if (!seriesStore || !seriesStore[key]) return null;
    const series = seriesStore[key];
    const data = series && Array.isArray(series.data) ? series.data : null;
    if (!data || data.length === 0) return null;
    const last = data[data.length - 1];
    return Number.isFinite(last) ? last : null;
}

function getStoreStats(structure) {
    if (!structure || !structure.store) {
        return {
            exists: false,
            used: 0,
            capacity: 0,
            free: 0,
            fillPct: 0
        };
    }
    const used = structure.store.getUsedCapacity();
    const capacity = structure.store.getCapacity();
    const free = structure.store.getFreeCapacity();
    const fillPct = capacity > 0 ? (used / capacity) : 0;
    return {
        exists: true,
        used,
        capacity,
        free,
        fillPct
    };
}

function getZeadminMemory() {
    if (!Memory.zeadmin || typeof Memory.zeadmin !== 'object') Memory.zeadmin = {};
    return Memory.zeadmin;
}

function getAssaultWatchdogState() {
    const root = getZeadminMemory();
    if (!root.assaultWatchdog || typeof root.assaultWatchdog !== 'object') {
        root.assaultWatchdog = {};
    }
    const cfg = root.assaultWatchdog;
    if (typeof cfg.enabled !== 'boolean') cfg.enabled = ASSAULT_WATCHDOG_DEFAULTS.enabled;
    if (typeof cfg.abortOnEarlyWipe !== 'boolean') cfg.abortOnEarlyWipe = ASSAULT_WATCHDOG_DEFAULTS.abortOnEarlyWipe;
    if (!Number.isFinite(cfg.earlyWipeTicks)) cfg.earlyWipeTicks = ASSAULT_WATCHDOG_DEFAULTS.earlyWipeTicks;
    if (!Number.isFinite(cfg.staleTicks)) cfg.staleTicks = ASSAULT_WATCHDOG_DEFAULTS.staleTicks;
    if (!Number.isFinite(cfg.maxEvents)) cfg.maxEvents = ASSAULT_WATCHDOG_DEFAULTS.maxEvents;
    if (!cfg.missions || typeof cfg.missions !== 'object') cfg.missions = {};
    if (!Array.isArray(cfg.events)) cfg.events = [];
    return cfg;
}

function pushAssaultEvent(watchdog, event) {
    if (!watchdog || !Array.isArray(watchdog.events) || !event) return;
    watchdog.events.push(event);
    const maxEvents = Math.max(10, Number(watchdog.maxEvents) || ASSAULT_WATCHDOG_DEFAULTS.maxEvents);
    if (watchdog.events.length > maxEvents) {
        watchdog.events.splice(0, watchdog.events.length - maxEvents);
    }
}

function makeAssaultMissionId(roomName, mission) {
    const data = mission && mission.data ? mission.data : {};
    const key = data.squadKey || mission.name || `assault:${roomName}`;
    return `${roomName}|${key}`;
}

function getAssaultLiveCountsBySquad() {
    const counts = {};
    for (const name in Game.creeps) {
        const creep = Game.creeps[name];
        if (!creep || !creep.my || !creep.memory) continue;
        if (creep.spawning) continue;
        const squad = creep.memory.assaultSquad;
        if (!squad || typeof squad !== 'string') continue;
        counts[squad] = (counts[squad] || 0) + 1;
    }
    return counts;
}

function getAssaultLiveCountsByMissionName() {
    const counts = {};
    for (const name in Game.creeps) {
        const creep = Game.creeps[name];
        if (!creep || !creep.my || !creep.memory) continue;
        if (creep.spawning) continue;
        const missionName = creep.memory.missionName;
        if (!missionName || typeof missionName !== 'string') continue;
        counts[missionName] = (counts[missionName] || 0) + 1;
    }
    return counts;
}

function getAssaultMissionLiveCount(mission, squadCounts, missionLiveCounts) {
    if (!mission) return 0;
    const data = mission.data || {};
    if (data.squadKey && squadCounts && Number.isFinite(squadCounts[data.squadKey])) {
        return squadCounts[data.squadKey];
    }
    if (mission.name && missionLiveCounts && Number.isFinite(missionLiveCounts[mission.name])) {
        return missionLiveCounts[mission.name];
    }
    if (mission.census && Number.isFinite(mission.census.count)) {
        return mission.census.count;
    }
    return 0;
}

function addFlagName(set, flagName) {
    if (!set || !flagName || typeof flagName !== 'string') return;
    const cleaned = flagName.trim();
    if (!cleaned) return;
    set[cleaned] = true;
}

function collectMissionFlagNames(mission) {
    const names = {};
    if (!mission || !mission.data) return [];
    const data = mission.data;
    if (data.flags && typeof data.flags === 'object') {
        addFlagName(names, data.flags.wait);
        addFlagName(names, data.flags.attack);
        addFlagName(names, data.flags.assembly);
        if (Array.isArray(data.flags.waypoints)) {
            for (let i = 0; i < data.flags.waypoints.length; i++) addFlagName(names, data.flags.waypoints[i]);
        }
    }
    addFlagName(names, data.waitFlagName);
    addFlagName(names, data.attackFlagName);
    addFlagName(names, data.assemblyFlagName);
    addFlagName(names, data.claimFlagName);
    if (Array.isArray(data.waypointFlagNames)) {
        for (let i = 0; i < data.waypointFlagNames.length; i++) addFlagName(names, data.waypointFlagNames[i]);
    }
    return Object.keys(names);
}

function abortAssaultByFlags(flagNames) {
    const removed = [];
    const missing = [];
    const unique = Array.isArray(flagNames) ? flagNames : [];
    for (let i = 0; i < unique.length; i++) {
        const flagName = unique[i];
        const flag = Game.flags[flagName];
        if (!flag) {
            missing.push(flagName);
            continue;
        }
        flag.remove();
        removed.push(flagName);
    }
    return { removed, missing };
}

function updateAssaultWatchdog(activeAssaultGroups) {
    const watchdog = getAssaultWatchdogState();
    const missions = watchdog.missions || {};
    const now = Game.time;
    const earlyWipeTicks = Math.max(1, Number(watchdog.earlyWipeTicks) || ASSAULT_WATCHDOG_DEFAULTS.earlyWipeTicks);
    const staleTicks = Math.max(100, Number(watchdog.staleTicks) || ASSAULT_WATCHDOG_DEFAULTS.staleTicks);
    const groups = activeAssaultGroups || {};

    for (const id in groups) {
        const group = groups[id];
        if (!group) continue;
        let entry = missions[id];
        const isNewEntry = !entry;
        if (!entry) {
            entry = missions[id] = {
                id,
                roomName: group.roomName,
                missionNames: [],
                squadKey: group.squadKey || null,
                mode: group.mode || null,
                assaultMode: group.assaultMode || null,
                targetRoom: group.targetRoom || null,
                flagNames: [],
                createdAt: now,
                assembledTrusted: false
            };
        }
        const wasMissingLastTick = Number.isFinite(entry.lastSeenAt) && entry.lastSeenAt < (now - 1);
        if (wasMissingLastTick) {
            entry.createdAt = now;
            entry.assembledAt = null;
            entry.lastWipedAt = null;
            entry.lastWipeAge = null;
            entry.abortIssuedAt = null;
            entry.abortReason = null;
            entry.abortResult = null;
            entry.lastLiveCount = 0;
        }

        entry.lastSeenAt = now;
        entry.roomName = group.roomName;
        entry.missionNames = group.missionNames;
        entry.squadKey = group.squadKey || null;
        entry.mode = group.mode || null;
        entry.assaultMode = group.assaultMode || null;
        entry.targetRoom = group.targetRoom || null;
        entry.flagNames = group.flagNames;

        const prevLive = Number(entry.lastLiveCount) || 0;
        const currentLive = Number(group.liveCount) || 0;
        entry.lastLiveCount = currentLive;
        const requiredAssembledLiveCount = entry.mode === 'DUO' ? 2 : 1;
        const crossedAssembledThreshold = prevLive < requiredAssembledLiveCount && currentLive >= requiredAssembledLiveCount;

        if (!entry.assembledAt && currentLive >= requiredAssembledLiveCount) {
            entry.assembledAt = now;
            entry.assembledTrusted = !isNewEntry && crossedAssembledThreshold;
            pushAssaultEvent(watchdog, {
                tick: now,
                type: 'assembled',
                id,
                roomName: entry.roomName,
                squadKey: entry.squadKey,
                missionNames: entry.missionNames,
                targetRoom: entry.targetRoom,
                trusted: !!entry.assembledTrusted
            });
        } else if (crossedAssembledThreshold) {
            entry.assembledAt = now;
            entry.assembledTrusted = true;
            pushAssaultEvent(watchdog, {
                tick: now,
                type: 'assembled',
                id,
                roomName: entry.roomName,
                squadKey: entry.squadKey,
                missionNames: entry.missionNames,
                targetRoom: entry.targetRoom,
                trusted: true
            });
        }

        if (prevLive > 0 && currentLive === 0) {
            entry.lastWipedAt = now;
            const age = entry.assembledAt ? (now - entry.assembledAt) : null;
            entry.lastWipeAge = age;
            pushAssaultEvent(watchdog, {
                tick: now,
                type: 'wiped',
                id,
                roomName: entry.roomName,
                squadKey: entry.squadKey,
                missionNames: entry.missionNames,
                targetRoom: entry.targetRoom,
                age
            });

            const isEarlyWipe = Number.isFinite(age) && age <= earlyWipeTicks;
            const shouldAbort = watchdog.enabled && watchdog.abortOnEarlyWipe && isEarlyWipe && entry.assembledTrusted === true && !entry.abortIssuedAt;
            if (shouldAbort) {
                const result = abortAssaultByFlags(entry.flagNames);
                entry.abortIssuedAt = now;
                entry.abortReason = `early_wipe<=${earlyWipeTicks}`;
                entry.abortResult = result;
                pushAssaultEvent(watchdog, {
                    tick: now,
                    type: 'aborted',
                    id,
                    roomName: entry.roomName,
                    squadKey: entry.squadKey,
                    missionNames: entry.missionNames,
                    targetRoom: entry.targetRoom,
                    reason: entry.abortReason,
                    removedFlags: result.removed,
                    missingFlags: result.missing
                });
            }
        }
    }

    for (const id in missions) {
        const entry = missions[id];
        if (!entry) continue;
        if (entry.lastSeenAt && now - entry.lastSeenAt > staleTicks) {
            delete missions[id];
        }
    }

    watchdog.missions = missions;

    const active = [];
    for (const id in missions) {
        const entry = missions[id];
        if (!entry) continue;
        const age = entry.assembledAt ? now - entry.assembledAt : null;
        active.push({
            id: entry.id,
            roomName: entry.roomName,
            missionNames: entry.missionNames,
            squadKey: entry.squadKey,
            mode: entry.mode,
            assaultMode: entry.assaultMode,
            targetRoom: entry.targetRoom,
            liveCount: Number(entry.lastLiveCount) || 0,
            assembledAt: entry.assembledAt || null,
            assembledTrusted: entry.assembledTrusted === true,
            age,
            lastWipedAt: entry.lastWipedAt || null,
            lastWipeAge: Number.isFinite(entry.lastWipeAge) ? entry.lastWipeAge : null,
            abortIssuedAt: entry.abortIssuedAt || null,
            flagNames: Array.isArray(entry.flagNames) ? entry.flagNames : []
        });
    }

    const recentEvents = watchdog.events.slice(-20);

    return {
        config: {
            enabled: !!watchdog.enabled,
            abortOnEarlyWipe: !!watchdog.abortOnEarlyWipe,
            earlyWipeTicks,
            staleTicks
        },
        active,
        recentEvents
    };
}

const managerZeadmin = {
    run: function() {
        const store = heap.getStore('zeadmin', { ttl: null });
        const telemetryStore = heap.getStore('telemetry', { ttl: null });
        const sparkStore = heap.getStore('sparkStats', { ttl: null });
        const resourceBalancingStore = heap.getStore('zeadmin_resource_balancing', { ttl: null });
        const sparkSeries = sparkStore && sparkStore.series ? sparkStore.series : null;

        const roomsOut = {};
        const homeCreepCounts = buildHomeCreepCounts();
        const assaultSquadLiveCounts = getAssaultLiveCountsBySquad();
        const assaultMissionLiveCounts = getAssaultLiveCountsByMissionName();
        const activeAssaultGroups = {};
        const empire = {
            telemetry: {
                cpu: {
                    ema: (telemetryStore && telemetryStore.cpu && Number.isFinite(telemetryStore.cpu.avgCpu))
                        ? telemetryStore.cpu.avgCpu
                        : 0
                },
                spark: {
                    cpuNow: getSeriesLast(sparkSeries, 'cpu.now'),
                    cpuEma: getSeriesLast(sparkSeries, 'cpu.ema'),
                    cpuBucket: getSeriesLast(sparkSeries, 'cpu.bucket'),
                    econEmpireTotal: getSeriesLast(sparkSeries, 'econ.empire.total'),
                    econEmpireAvg: getSeriesLast(sparkSeries, 'econ.empire.avg'),
                    econEmpireSample: getSeriesLast(sparkSeries, 'econ.empire.sample')
                }
            },
            cpu: {
                used: 0,
                limit: Game.cpu.limit,
                tickLimit: Game.cpu.tickLimit,
                bucket: Game.cpu.bucket,
                usedPctOfLimit: 0,
                usedPctOfTickLimit: 0
            },
            roomCount: 0,
            missionCount: 0,
            spawnTicketCount: 0,
            ownedCreepCount: 0,
            energy: {
                available: 0,
                capacity: 0,
                stored: 0
            },
            storage: {
                used: 0,
                capacity: 0,
                fillPct: 0,
                pressuredRooms: 0
            },
            terminal: {
                used: 0,
                capacity: 0,
                fillPct: 0,
                pressuredRooms: 0
            },
            states: {
                ops: {},
                economy: {},
                combat: {},
                overall: {}
            },
            assault: {
                activeCount: 0,
                assembledCount: 0,
                recentlyAborted: 0,
                recentlyWiped: 0,
                config: {
                    enabled: ASSAULT_WATCHDOG_DEFAULTS.enabled,
                    abortOnEarlyWipe: ASSAULT_WATCHDOG_DEFAULTS.abortOnEarlyWipe,
                    earlyWipeTicks: ASSAULT_WATCHDOG_DEFAULTS.earlyWipeTicks
                }
            },
            resourceBalancing: (resourceBalancingStore && resourceBalancingStore.lastSummary)
                ? resourceBalancingStore.lastSummary
                : null
        };

        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (!room || !room.controller || !room.controller.my) continue;

            const overseer = room.memory && room.memory.overseer ? room.memory.overseer : {};
            const admiral = room.memory && room.memory.admiral ? room.memory.admiral : {};
            const opsState = room._opState || overseer.opState || 'UNKNOWN';
            const economyState = room._economyState || overseer.economyState || 'UNKNOWN';
            const combatState = room._combatState || admiral.state || 'UNKNOWN';
            const overallState = room._roomState && room._roomState.overall
                ? room._roomState.overall
                : deriveOverallState(opsState, combatState);
            const missions = Array.isArray(room._missions) ? room._missions : [];
            const missionByType = countMissionsByType(missions);
            const assaultMissions = missions.filter(m => m && m.type === 'assault');
            const spawnTickets = Array.isArray(room._spawnTicketsToRequest) ? room._spawnTicketsToRequest : [];
            const ledgerEnergy = overseer.resourceLedger && overseer.resourceLedger.energy
                ? overseer.resourceLedger.energy
                : null;
            const roomStoredEnergy = ledgerEnergy && Number.isFinite(ledgerEnergy.total)
                ? ledgerEnergy.total
                : ((room.storage && room.storage.store && room.storage.store[RESOURCE_ENERGY]) || 0) +
                  ((room.terminal && room.terminal.store && room.terminal.store[RESOURCE_ENERGY]) || 0);
            const homeCreepCount = homeCreepCounts[room.name] || 0;
            const storageStats = getStoreStats(room.storage);
            const terminalStats = getStoreStats(room.terminal);

            const roomReport = {
                tick: Game.time,
                states: {
                    ops: opsState,
                    economy: economyState,
                    combat: combatState,
                    overall: overallState
                },
                energy: {
                    available: room.energyAvailable,
                    capacity: room.energyCapacityAvailable,
                    stored: roomStoredEnergy
                },
                storage: storageStats,
                terminal: terminalStats,
                missions: {
                    total: missions.length,
                    byType: missionByType
                },
                assault: {
                    missionCount: assaultMissions.length
                },
                spawn: {
                    pendingTickets: spawnTickets.length
                },
                creeps: {
                    homeOwned: homeCreepCount
                }
            };

            roomsOut[room.name] = roomReport;

            for (let i = 0; i < assaultMissions.length; i++) {
                const mission = assaultMissions[i];
                const id = makeAssaultMissionId(room.name, mission);
                if (!activeAssaultGroups[id]) {
                    activeAssaultGroups[id] = {
                        id,
                        roomName: room.name,
                        squadKey: mission.data && mission.data.squadKey ? mission.data.squadKey : null,
                        mode: mission.data && mission.data.mode ? mission.data.mode : null,
                        assaultMode: mission.data && mission.data.assaultMode ? mission.data.assaultMode : null,
                        targetRoom: mission.data && mission.data.targetRoom ? mission.data.targetRoom : null,
                        missionNames: [],
                        flagNames: [],
                        _flagSet: {},
                        liveCount: 0
                    };
                }
                const group = activeAssaultGroups[id];
                group.missionNames.push(mission.name);
                const missionLiveCount = getAssaultMissionLiveCount(mission, assaultSquadLiveCounts, assaultMissionLiveCounts);
                if (missionLiveCount > group.liveCount) group.liveCount = missionLiveCount;
                const flags = collectMissionFlagNames(mission);
                for (let j = 0; j < flags.length; j++) {
                    const flagName = flags[j];
                    if (group._flagSet[flagName]) continue;
                    group._flagSet[flagName] = true;
                    group.flagNames.push(flagName);
                }
            }

            empire.roomCount += 1;
            empire.missionCount += missions.length;
            empire.spawnTicketCount += spawnTickets.length;
            empire.ownedCreepCount += homeCreepCount;
            empire.energy.available += room.energyAvailable;
            empire.energy.capacity += room.energyCapacityAvailable;
            empire.energy.stored += roomStoredEnergy;
            empire.storage.used += storageStats.used;
            empire.storage.capacity += storageStats.capacity;
            empire.terminal.used += terminalStats.used;
            empire.terminal.capacity += terminalStats.capacity;
            if (storageStats.exists && storageStats.fillPct >= 0.9) empire.storage.pressuredRooms += 1;
            if (terminalStats.exists && terminalStats.fillPct >= 0.9) empire.terminal.pressuredRooms += 1;

            empire.states.ops[opsState] = (empire.states.ops[opsState] || 0) + 1;
            empire.states.economy[economyState] = (empire.states.economy[economyState] || 0) + 1;
            empire.states.combat[combatState] = (empire.states.combat[combatState] || 0) + 1;
            empire.states.overall[overallState] = (empire.states.overall[overallState] || 0) + 1;
        }

        for (const id in activeAssaultGroups) {
            if (!Object.prototype.hasOwnProperty.call(activeAssaultGroups, id)) continue;
            delete activeAssaultGroups[id]._flagSet;
        }

        const assaultSummary = updateAssaultWatchdog(activeAssaultGroups);

        empire.cpu.used = Game.cpu.getUsed();
        empire.cpu.usedPctOfLimit = empire.cpu.limit > 0
            ? (empire.cpu.used / empire.cpu.limit) * 100
            : 0;
        empire.cpu.usedPctOfTickLimit = empire.cpu.tickLimit > 0
            ? (empire.cpu.used / empire.cpu.tickLimit) * 100
            : 0;
        empire.storage.fillPct = empire.storage.capacity > 0 ? (empire.storage.used / empire.storage.capacity) : 0;
        empire.terminal.fillPct = empire.terminal.capacity > 0 ? (empire.terminal.used / empire.terminal.capacity) : 0;
        empire.assault.activeCount = assaultSummary.active.length;
        empire.assault.assembledCount = assaultSummary.active.filter(m => !!m.assembledAt).length;
        empire.assault.recentlyAborted = assaultSummary.recentEvents.filter(e => e && e.type === 'aborted').length;
        empire.assault.recentlyWiped = assaultSummary.recentEvents.filter(e => e && e.type === 'wiped').length;
        empire.assault.config = assaultSummary.config;

        store.version = 1;
        store.tick = Game.time;
        store.rooms = roomsOut;
        store.empire = empire;
        store.assault = assaultSummary;
        global.zeadminSnapshot = store;
    }
};

module.exports = managerZeadmin;
