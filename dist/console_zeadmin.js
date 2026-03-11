const heap = require('utils_heap');

function showHelp() {
    const lines = [
        'zeadmin()                  - show this help',
        'zeadmin("show")            - show empire overview from heap snapshot',
        'zeadmin("rooms")           - list per-room overview',
        'zeadmin("room", "W1N1")    - show one room snapshot'
    ];
    for (const line of lines) console.log(line);
    return 'Done';
}

function getSnapshot() {
    const store = heap.getStore('zeadmin', { ttl: null });
    if (!store || !store.tick || !store.empire) return null;
    return store;
}

function printEmpire(snapshot) {
    const e = snapshot.empire || {};
    const energy = e.energy || {};
    const cpu = e.cpu || {};
    const telemetry = e.telemetry || {};
    const telemetryCpu = telemetry.cpu || {};
    const telemetrySpark = telemetry.spark || {};
    console.log(`ZEADMIN snapshot tick=${snapshot.tick} rooms=${e.roomCount || 0}`);
    console.log(
        `cpu: used=${Number(cpu.used || 0).toFixed(2)} ` +
        `limit=${cpu.limit || 0} tickLimit=${cpu.tickLimit || 0} bucket=${cpu.bucket || 0} ` +
        `used/limit=${Number(cpu.usedPctOfLimit || 0).toFixed(1)}% used/tickLimit=${Number(cpu.usedPctOfTickLimit || 0).toFixed(1)}%`
    );
    console.log(
        `telemetry: cpu.ema=${Number(telemetryCpu.ema || 0).toFixed(2)} ` +
        `spark.cpuNow=${telemetrySpark.cpuNow == null ? 'n/a' : Number(telemetrySpark.cpuNow).toFixed(2)} ` +
        `spark.cpuEma=${telemetrySpark.cpuEma == null ? 'n/a' : Number(telemetrySpark.cpuEma).toFixed(2)} ` +
        `spark.cpuBucket=${telemetrySpark.cpuBucket == null ? 'n/a' : Number(telemetrySpark.cpuBucket).toFixed(0)}`
    );
    console.log(
        `telemetry.econ: total=${telemetrySpark.econEmpireTotal == null ? 'n/a' : Number(telemetrySpark.econEmpireTotal).toFixed(0)} ` +
        `avg=${telemetrySpark.econEmpireAvg == null ? 'n/a' : Number(telemetrySpark.econEmpireAvg).toFixed(2)} ` +
        `sample=${telemetrySpark.econEmpireSample == null ? 'n/a' : Number(telemetrySpark.econEmpireSample).toFixed(2)}`
    );
    console.log(`missions=${e.missionCount || 0} pendingTickets=${e.spawnTicketCount || 0} homeOwnedCreeps=${e.ownedCreepCount || 0}`);
    console.log(`energy: available=${energy.available || 0} capacity=${energy.capacity || 0} stored=${energy.stored || 0}`);
    console.log(`states.overall=${JSON.stringify((e.states && e.states.overall) || {})}`);
    console.log(`states.ops=${JSON.stringify((e.states && e.states.ops) || {})}`);
    console.log(`states.economy=${JSON.stringify((e.states && e.states.economy) || {})}`);
    console.log(`states.combat=${JSON.stringify((e.states && e.states.combat) || {})}`);
    return 'Done';
}

function printRooms(snapshot) {
    const rooms = snapshot.rooms || {};
    const names = Object.keys(rooms).sort();
    if (names.length === 0) {
        console.log('ZEADMIN rooms: (none)');
        return 'Done';
    }
    console.log(`ZEADMIN rooms tick=${snapshot.tick}`);
    for (const roomName of names) {
        const room = rooms[roomName] || {};
        const states = room.states || {};
        const energy = room.energy || {};
        const missions = room.missions || {};
        const spawn = room.spawn || {};
        const creeps = room.creeps || {};
        console.log(
            `${roomName} overall=${states.overall || 'UNKNOWN'} ` +
            `ops=${states.ops || 'UNKNOWN'} eco=${states.economy || 'UNKNOWN'} combat=${states.combat || 'UNKNOWN'} ` +
            `missions=${missions.total || 0} tickets=${spawn.pendingTickets || 0} creeps=${creeps.homeOwned || 0} ` +
            `energy=${energy.available || 0}/${energy.capacity || 0} stored=${energy.stored || 0}`
        );
    }
    return 'Done';
}

function printRoom(snapshot, roomName) {
    const name = roomName ? ('' + roomName).trim().toUpperCase() : '';
    if (!name) return 'Usage: zeadmin("room", "W1N1")';

    const room = snapshot.rooms && snapshot.rooms[name];
    if (!room) return `No zeadmin snapshot for room: ${name}`;

    const states = room.states || {};
    const energy = room.energy || {};
    const missions = room.missions || {};
    const spawn = room.spawn || {};
    const creeps = room.creeps || {};

    console.log(`ZEADMIN ${name} tick=${room.tick || snapshot.tick}`);
    console.log(`states: overall=${states.overall || 'UNKNOWN'} ops=${states.ops || 'UNKNOWN'} economy=${states.economy || 'UNKNOWN'} combat=${states.combat || 'UNKNOWN'}`);
    console.log(`energy: available=${energy.available || 0} capacity=${energy.capacity || 0} stored=${energy.stored || 0}`);
    console.log(`missions: total=${missions.total || 0} byType=${JSON.stringify(missions.byType || {})}`);
    console.log(`spawn: pendingTickets=${spawn.pendingTickets || 0}`);
    console.log(`creeps: homeOwned=${creeps.homeOwned || 0}`);
    return 'Done';
}

module.exports = function registerZeadminConsole() {
    global.zeadmin = function(action, ...args) {
        const cmd = action ? ('' + action).trim().toLowerCase() : 'help';
        if (!cmd || cmd === 'help' || cmd === 'h') return showHelp();

        const snapshot = getSnapshot();
        if (!snapshot) return 'ZEADMIN snapshot is empty. Wait one tick after code load.';

        if (cmd === 'show' || cmd === 'status' || cmd === 's') return printEmpire(snapshot);
        if (cmd === 'rooms' || cmd === 'list' || cmd === 'ls') return printRooms(snapshot);
        if (cmd === 'room') return printRoom(snapshot, args[0]);

        return showHelp();
    };
};
