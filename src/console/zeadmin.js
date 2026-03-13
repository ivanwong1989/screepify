const heap = require('utils_heap');

function showHelp() {
    const lines = [
        'zeadmin()                  - show this help',
        'zeadmin("show")            - show empire overview from heap snapshot',
        'zeadmin("rooms")           - list per-room overview',
        'zeadmin("room", "W1N1")    - show one room snapshot',
        'zeadmin("balance")         - show latest resource balancing summary',
        'zeadmin("assault")         - show assault lifecycle/watchdog status'
    ];
    for (const line of lines) console.log(line);
    return 'Done';
}

function getSnapshot() {
    const store = heap.getStore('zeadmin', { ttl: null });
    if (!store || !store.tick || !store.empire) return null;
    return store;
}

function getStockTargetAuthorityStatus() {
    const rb = Memory.zeadmin && Memory.zeadmin.resourceBalancing
        ? Memory.zeadmin.resourceBalancing
        : null;
    const enabled = !!(rb && rb.enabled !== false);
    const stockTargetsEnabled = !!(rb && rb.stockTargetsEnabled !== false);
    return {
        zeadminOwnsStockTargets: enabled && stockTargetsEnabled,
        enabled,
        stockTargetsEnabled
    };
}

function printEmpire(snapshot) {
    const e = snapshot.empire || {};
    const energy = e.energy || {};
    const cpu = e.cpu || {};
    const telemetry = e.telemetry || {};
    const telemetryCpu = telemetry.cpu || {};
    const telemetrySpark = telemetry.spark || {};
    const emaUsed = Number(telemetryCpu.ema || 0);
    const emaPctOfLimit = cpu.limit > 0 ? ((emaUsed / cpu.limit) * 100) : 0;
    const emaPctOfTickLimit = cpu.tickLimit > 0 ? ((emaUsed / cpu.tickLimit) * 100) : 0;
    const storage = e.storage || {};
    const terminal = e.terminal || {};
    const balancing = e.resourceBalancing || null;
    console.log(`ZEADMIN snapshot tick=${snapshot.tick} rooms=${e.roomCount || 0}`);
    console.log(
        `cpu: emaUsed=${emaUsed.toFixed(2)} ` +
        `limit=${cpu.limit || 0} tickLimit=${cpu.tickLimit || 0} bucket=${cpu.bucket || 0} ` +
        `ema/limit=${emaPctOfLimit.toFixed(1)}% ema/tickLimit=${emaPctOfTickLimit.toFixed(1)}%`
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
    console.log(
        `storage: used=${storage.used || 0} cap=${storage.capacity || 0} ` +
        `fill=${Number(storage.fillPct || 0).toFixed(3)} pressuredRooms=${storage.pressuredRooms || 0}`
    );
    console.log(
        `terminal: used=${terminal.used || 0} cap=${terminal.capacity || 0} ` +
        `fill=${Number(terminal.fillPct || 0).toFixed(3)} pressuredRooms=${terminal.pressuredRooms || 0}`
    );
    if (balancing) {
        const authority = getStockTargetAuthorityStatus();
        console.log(
            `balance: core=${balancing.coreRoom || 'n/a'} sends=${balancing.sends || 0} ` +
            `candidates=${balancing.candidateCount || 0} pressured=${balancing.pressuredRoomCount || 0} ` +
            `stockWrites=${balancing.stockTargetWrites || 0} reason=${balancing.reason || 'n/a'}`
        );
        console.log(
            `terminalStockTargets.authority=${authority.zeadminOwnsStockTargets ? 'zeadmin' : 'market/default'} ` +
            `zeadminEnabled=${authority.enabled ? 'yes' : 'no'} stockTargetsEnabled=${authority.stockTargetsEnabled ? 'yes' : 'no'}`
        );
        if (balancing.basicMineralCount) {
            const basic = Array.isArray(balancing.basicMinerals) ? balancing.basicMinerals : [];
            console.log(`balance.basicMinerals=${balancing.basicMineralCount} [${basic.join(',')}]`);
        }
        if (balancing.managedResourceCount) {
            const list = Array.isArray(balancing.managedResources) ? balancing.managedResources : [];
            console.log(
                `balance.resources=${balancing.managedResourceCount} ` +
                `sample=[${list.join(',')}]`
            );
        }

        const balanceStore = heap.getStore('zeadmin_resource_balancing', { ttl: null });
        const transfers = Array.isArray(balanceStore && balanceStore.lastTransfers) ? balanceStore.lastTransfers : [];
        if (transfers.length > 0) {
            console.log('balance.lastTransfers:');
            for (const t of transfers.slice(0, 5)) {
                console.log(
                    `${t.tick} ${t.from}->${t.to} ${t.resourceType || 'res'} amount=${t.amount} ` +
                    `cost~${t.estimatedEnergyCost} cpu=${t.costPerUnit == null ? 'n/a' : Number(t.costPerUnit).toFixed(3)} ` +
                    `ok=${t.ok ? 'yes' : 'no'}${t.error ? ` error=${t.error}` : ''}`
                );
            }
        }
    }
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
        const storage = room.storage || {};
        const terminal = room.terminal || {};
        const missions = room.missions || {};
        const spawn = room.spawn || {};
        const creeps = room.creeps || {};
        console.log(
            `${roomName} overall=${states.overall || 'UNKNOWN'} ` +
            `ops=${states.ops || 'UNKNOWN'} eco=${states.economy || 'UNKNOWN'} combat=${states.combat || 'UNKNOWN'} ` +
            `missions=${missions.total || 0} tickets=${spawn.pendingTickets || 0} creeps=${creeps.homeOwned || 0} ` +
            `energy=${energy.available || 0}/${energy.capacity || 0} stored=${energy.stored || 0} ` +
            `storageFill=${Number(storage.fillPct || 0).toFixed(2)} terminalFill=${Number(terminal.fillPct || 0).toFixed(2)}`
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
    const storage = room.storage || {};
    const terminal = room.terminal || {};
    const missions = room.missions || {};
    const spawn = room.spawn || {};
    const creeps = room.creeps || {};

    console.log(`ZEADMIN ${name} tick=${room.tick || snapshot.tick}`);
    console.log(`states: overall=${states.overall || 'UNKNOWN'} ops=${states.ops || 'UNKNOWN'} economy=${states.economy || 'UNKNOWN'} combat=${states.combat || 'UNKNOWN'}`);
    console.log(`energy: available=${energy.available || 0} capacity=${energy.capacity || 0} stored=${energy.stored || 0}`);
    console.log(
        `storage: used=${storage.used || 0} cap=${storage.capacity || 0} ` +
        `free=${storage.free || 0} fill=${Number(storage.fillPct || 0).toFixed(3)}`
    );
    console.log(
        `terminal: used=${terminal.used || 0} cap=${terminal.capacity || 0} ` +
        `free=${terminal.free || 0} fill=${Number(terminal.fillPct || 0).toFixed(3)}`
    );
    console.log(`missions: total=${missions.total || 0} byType=${JSON.stringify(missions.byType || {})}`);
    console.log(`spawn: pendingTickets=${spawn.pendingTickets || 0}`);
    console.log(`creeps: homeOwned=${creeps.homeOwned || 0}`);
    return 'Done';
}

function printBalance() {
    const store = heap.getStore('zeadmin_resource_balancing', { ttl: null });
    if (!store || !store.lastSummary) return 'No resource balancing data yet.';
    const s = store.lastSummary;
    console.log(
        `ZEADMIN balance tick=${store.lastTick || 0} enabled=${s.enabled ? 'yes' : 'no'} ` +
        `core=${s.coreRoom || 'n/a'} sends=${s.sends || 0} candidates=${s.candidateCount || 0} ` +
        `pressured=${s.pressuredRoomCount || 0} reason=${s.reason || 'n/a'}`
    );
    if (s.basicMineralCount) {
        const basic = Array.isArray(s.basicMinerals) ? s.basicMinerals : [];
        console.log(`basicMinerals=${s.basicMineralCount} [${basic.join(',')}]`);
    }
    const transfers = Array.isArray(store.lastTransfers) ? store.lastTransfers : [];
    if (transfers.length === 0) {
        console.log('lastTransfers: (none)');
        return 'Done';
    }
    console.log('lastTransfers:');
    for (const t of transfers.slice(0, 10)) {
        console.log(
            `${t.tick} ${t.from} -> ${t.to} amount=${t.amount} ` +
            `cost~${t.estimatedEnergyCost} ok=${t.ok ? 'yes' : 'no'}${t.error ? ` error=${t.error}` : ''}`
        );
    }
    return 'Done';
}

function printAssault(snapshot) {
    const assault = snapshot.assault || {};
    const cfg = assault.config || {};
    const active = Array.isArray(assault.active) ? assault.active : [];
    const events = Array.isArray(assault.recentEvents) ? assault.recentEvents : [];

    console.log(
        `ZEADMIN assault tick=${snapshot.tick} active=${active.length} ` +
        `enabled=${cfg.enabled ? 'yes' : 'no'} abortOnEarlyWipe=${cfg.abortOnEarlyWipe ? 'yes' : 'no'} ` +
        `earlyWipeTicks=${cfg.earlyWipeTicks || 0}`
    );

    if (active.length === 0) {
        console.log('active: (none)');
    } else {
        console.log('active:');
        for (const entry of active) {
            const missions = Array.isArray(entry.missionNames) ? entry.missionNames.join(',') : '';
            const flags = Array.isArray(entry.flagNames) ? entry.flagNames.join(',') : '';
            console.log(
                `${entry.id} room=${entry.roomName} live=${entry.liveCount || 0} ` +
                `assembledAt=${entry.assembledAt || 'n/a'} assembledTrusted=${entry.assembledTrusted ? 'yes' : 'no'} age=${entry.age == null ? 'n/a' : entry.age} ` +
                `lastWipedAt=${entry.lastWipedAt || 'n/a'} wipeAge=${entry.lastWipeAge == null ? 'n/a' : entry.lastWipeAge} ` +
                `abortedAt=${entry.abortIssuedAt || 'n/a'} mode=${entry.mode || 'n/a'} assaultMode=${entry.assaultMode || 'n/a'} ` +
                `target=${entry.targetRoom || 'n/a'} missions=[${missions}] flags=[${flags}]`
            );
        }
    }

    if (events.length === 0) {
        console.log('recentEvents: (none)');
    } else {
        console.log('recentEvents:');
        for (const event of events.slice(-20)) {
            console.log(
                `${event.tick} type=${event.type} id=${event.id} room=${event.roomName || 'n/a'} ` +
                `target=${event.targetRoom || 'n/a'} age=${event.age == null ? 'n/a' : event.age} ` +
                `${event.reason ? `reason=${event.reason} ` : ''}` +
                `${event.removedFlags ? `removed=[${event.removedFlags.join(',')}] ` : ''}` +
                `${event.missingFlags ? `missing=[${event.missingFlags.join(',')}]` : ''}`.trim()
            );
        }
    }

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
        if (cmd === 'balance' || cmd === 'bal') return printBalance();
        if (cmd === 'assault' || cmd === 'ass' || cmd === 'war') return printAssault(snapshot);

        return showHelp();
    };
};
