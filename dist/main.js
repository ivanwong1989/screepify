var registerGlobals = require('bootstrap_globals');
var registerConsole = require('console_index');

registerGlobals();
registerConsole();

var roleUniversal = require('role.universal');
var roleDefender = require('role.defender');
var roleAssault = require('role.assault');
var roleTower = require('role.tower');
var runColony = require('runColony');
var cpuEma = require('telemetry_cpuEma');
var sparkStats = require('utils_sparkStats');
var managerGlobalSpawner = require('managers_spawner_manager.global.spawner');

function computeCpuMode() {
  const limit = Game.cpu.limit;
  const used = Game.cpu.getUsed();      // used so far this tick
  const bucket = Game.cpu.bucket;
  const avg = Number(Memory.avgCpu || 0); // you already maintain this in telemetry/cpuEma

  // Simple, stable thresholds (tweak later)
  if (bucket < 800 || used > limit * 0.92) return 'PANIC';
  if (bucket < 3500 || avg > limit * 0.85) return 'THROTTLE';
  return 'FULL';
}

// Any modules that you use that modify the game's prototypes should be require'd
// before you require the profiler.
//const profiler = require('screeps-profiler');

// This line monkey patches the global prototypes.
//profiler.enable();
module.exports.loop = function() {
    //profiler.wrap(function() {
        // Main.js logic should go here.

        // --- Quick dirty shard detection and pixel farm for now --- 
        // --- shard-specific pixel logic ---
        if (Game.shard && Game.shard.name === 'shard2') {
            if (Game.cpu.bucket >= 10000) {
                Game.cpu.generatePixel();
            }
        }
        // --- END Quick dirty shard detection and pixel farm for now ---

        // --- Initialize Remote Memory ---
        if (!Memory.remoteRooms) Memory.remoteRooms = {};
        if (!Memory.spawnTickets) Memory.spawnTickets = {};
        if (!global._spawningNamesCache || global._spawningNamesCache.time !== Game.time) {
            const spawningNames = new Set();
            for (const rn in Game.rooms) {
                const r = Game.rooms[rn];
                if (!r.controller || !r.controller.my) continue;
                const spawns = r.find(FIND_MY_SPAWNS);
                for (const s of spawns) {
                    if (s.spawning) spawningNames.add(s.spawning.name);
                }
            }
            global._spawningNamesCache = { time: Game.time, names: spawningNames };
        }

        // --- Spawn Ticket GC (prevents unbounded growth) ---
        (function cleanupSpawnTickets() {
            const tickets = Memory.spawnTickets;
            const spawningNames = global._spawningNamesCache && global._spawningNamesCache.time === Game.time
                ? global._spawningNamesCache.names
                : null;

            for (const id in tickets) {
                const t = tickets[id];
                if (!t) {
                    delete tickets[id];
                    continue;
                }

                const expired = t.expiresAt && t.expiresAt <= Game.time;
                const creepAlive = t.creepName && Game.creeps[t.creepName];
                const creepSpawning = t.creepName && spawningNames && spawningNames.has(t.creepName);

                if (expired && !creepAlive && !creepSpawning) {
                    delete tickets[id];
                    const home = t.homeRoom;
                    const contractId = t.contractId;
                    if (home && contractId && Memory.rooms && Memory.rooms[home] && Memory.rooms[home].spawnTicketsByKey) {
                        const index = Memory.rooms[home].spawnTicketsByKey;
                        const list = index[contractId];
                        if (list && list.length > 0) {
                            index[contractId] = list.filter(tid => tid !== id);
                        }
                    }
                    continue;
                }

                // If expired but creep exists, keep ticket and let tasker refresh.
                if (expired && creepAlive) {
                    t.expiresAt = Game.time + 50;
                }
            }
        })();

        // --- Memory name garbage clearing ---
        for (var name in Memory.creeps) {
            if (!Game.creeps[name]) {
                delete Memory.creeps[name];
                debug('system', 'Clearing non-existing creep memory:', name);
            }
        }

        // --- Run Mission Manager ---

        // --- COLONY LOOP ---
        const allCreeps = Object.values(Game.creeps);

        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];

            // Check if this is a valid colony (Owned controller + Spawns)
            if (room.controller && room.controller.my) {
                const cache = global.getRoomCache(room);
                const spawns = cache.myStructuresByType[STRUCTURE_SPAWN] || [];
                if (spawns.length > 0) {
                    // Run Colony Logic for this room
                    runColony.run(room, spawns[0], allCreeps);
                }

                // Run towers after Colony Logic (so Tasker has assigned tasks)
                const towers = cache.myStructuresByType[STRUCTURE_TOWER] || [];
                for (const tower of towers) {
                    roleTower.run(tower);
                }
            }
        }

        // --- GLOBAL SPAWN MANAGER ---
        // Collect tickets from all rooms
        let allSpawnTickets = [];
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (room._spawnTicketsToRequest) allSpawnTickets.push(...room._spawnTicketsToRequest);
        }
        managerGlobalSpawner.run(allSpawnTickets);

        // --- CREEP RUN LOGIC ---
        // Run creep logic globally, as they may be in any room
        for (var name in Game.creeps) {
            var creep = Game.creeps[name];
            if (creep.memory.role === 'defender' || creep.memory.role === 'brawler' || creep.memory.role === 'drainer') {
                roleDefender.run(creep);
            } else if (creep.memory.role === 'assault') {
                roleAssault.run(creep);
            } else if ([
                'universal',
                'miner',
                'remote_miner',
                'mineral_miner',
                'mobile_miner',
                'scout',
                'hauler',
                'user_hauler',
                'remote_hauler',
                'upgrader',
                'builder',
                'repairer',
                'worker',
                'remote_worker',
                'dismantler',
                'reserver',
                'claimer',
                'move2flag'
            ].includes(creep.memory.role)) {
                roleUniversal.run(creep);
            }
        }

        // cpu EMA counted
        cpuEma.tick();
        
        // Sparkline stats 
        if (Game.time % 5 === 0) {
            sparkStats.pushSeries('cpu.now', Game.cpu.getUsed(), { maxLen: 60 });
            sparkStats.pushSeries('cpu.ema', Memory.avgCpu, { maxLen: 60 });
            sparkStats.pushSeries('cpu.bucket', Game.cpu.bucket, { maxLen: 60 });

            // Total stored energy
            let energy = 0;
            for (const rName in Game.rooms) {
                const room = Game.rooms[rName];
                if (!room.controller || !room.controller.my) continue;
                const storage = room.storage;
                if (storage) energy += storage.store.energy || 0;
            }
            sparkStats.pushSeries('energy.storage', energy, { maxLen: 60 });
        }

        if (Memory.sparkStatsPrint !== false && Game.time % 20 === 0) {
            console.log(sparkStats.printSeries('cpu.now', { label: 'CPU used' }));
            console.log(sparkStats.printSeries('cpu.ema', { label: 'CPU ema', min: 0, max: Game.cpu.limit }));
            console.log(sparkStats.printSeries('cpu.bucket', { label: 'CPU bucket', min: 0, max: 10000 }));
            console.log(sparkStats.printSeries('energy.storage', { label: 'Storage E' }));
        }


    //});
};
