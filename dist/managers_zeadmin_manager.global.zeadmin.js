const heap = require('utils_heap');

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

const managerZeadmin = {
    run: function() {
        const store = heap.getStore('zeadmin', { ttl: null });
        const telemetryStore = heap.getStore('telemetry', { ttl: null });
        const sparkStore = heap.getStore('sparkStats', { ttl: null });
        const sparkSeries = sparkStore && sparkStore.series ? sparkStore.series : null;

        const roomsOut = {};
        const homeCreepCounts = buildHomeCreepCounts();
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
            states: {
                ops: {},
                economy: {},
                combat: {},
                overall: {}
            }
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
            const spawnTickets = Array.isArray(room._spawnTicketsToRequest) ? room._spawnTicketsToRequest : [];
            const ledgerEnergy = overseer.resourceLedger && overseer.resourceLedger.energy
                ? overseer.resourceLedger.energy
                : null;
            const roomStoredEnergy = ledgerEnergy && Number.isFinite(ledgerEnergy.total)
                ? ledgerEnergy.total
                : ((room.storage && room.storage.store && room.storage.store[RESOURCE_ENERGY]) || 0) +
                  ((room.terminal && room.terminal.store && room.terminal.store[RESOURCE_ENERGY]) || 0);
            const homeCreepCount = homeCreepCounts[room.name] || 0;

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
                missions: {
                    total: missions.length,
                    byType: missionByType
                },
                spawn: {
                    pendingTickets: spawnTickets.length
                },
                creeps: {
                    homeOwned: homeCreepCount
                }
            };

            roomsOut[room.name] = roomReport;

            empire.roomCount += 1;
            empire.missionCount += missions.length;
            empire.spawnTicketCount += spawnTickets.length;
            empire.ownedCreepCount += homeCreepCount;
            empire.energy.available += room.energyAvailable;
            empire.energy.capacity += room.energyCapacityAvailable;
            empire.energy.stored += roomStoredEnergy;

            empire.states.ops[opsState] = (empire.states.ops[opsState] || 0) + 1;
            empire.states.economy[economyState] = (empire.states.economy[economyState] || 0) + 1;
            empire.states.combat[combatState] = (empire.states.combat[combatState] || 0) + 1;
            empire.states.overall[overallState] = (empire.states.overall[overallState] || 0) + 1;
        }

        empire.cpu.used = Game.cpu.getUsed();
        empire.cpu.usedPctOfLimit = empire.cpu.limit > 0
            ? (empire.cpu.used / empire.cpu.limit) * 100
            : 0;
        empire.cpu.usedPctOfTickLimit = empire.cpu.tickLimit > 0
            ? (empire.cpu.used / empire.cpu.tickLimit) * 100
            : 0;

        store.version = 1;
        store.tick = Game.time;
        store.rooms = roomsOut;
        store.empire = empire;
        global.zeadminSnapshot = store;
    }
};

module.exports = managerZeadmin;
