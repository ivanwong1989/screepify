const heap = require('utils_heap');
const managerTerminal = require('managers_structures_manager.terminal');

const STORE_KEY = 'zeadmin_resource_balancing';
const CONFIG_ROOT_KEY = 'resourceBalancing';

const DEFAULTS = Object.freeze({
    enabled: true,
    runEvery: 5,
    coreRoom: null,
    storageFillThresholdPct: 0.9,
    terminalFillThresholdPct: 0.9,
    minSourceTerminalEnergyReserve: 15000,
    minTargetTerminalFree: 10000,
    minSendAmount: 5000,
    maxSendAmount: 20000,
    maxSendsPerTick: 1
});

function clampNumber(value, fallback, min, max) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    const lo = Number.isFinite(min) ? min : -Infinity;
    const hi = Number.isFinite(max) ? max : Infinity;
    if (num < lo) return lo;
    if (num > hi) return hi;
    return num;
}

function normalizeRoomName(roomName) {
    return ('' + (roomName || '')).trim().toUpperCase();
}

function ensureStore() {
    const store = heap.getStore(STORE_KEY, { ttl: null });
    if (!store.version) store.version = 1;
    if (!store.lastTick) store.lastTick = 0;
    if (!store.lastTransfers) store.lastTransfers = [];
    if (!store.lastRooms) store.lastRooms = {};
    if (!store.lastSummary) store.lastSummary = {};
    return store;
}

function ensureConfig() {
    if (!Memory.zeadmin || typeof Memory.zeadmin !== 'object') Memory.zeadmin = {};
    if (!Memory.zeadmin[CONFIG_ROOT_KEY] || typeof Memory.zeadmin[CONFIG_ROOT_KEY] !== 'object') {
        Memory.zeadmin[CONFIG_ROOT_KEY] = {};
    }

    const cfg = Memory.zeadmin[CONFIG_ROOT_KEY];
    cfg.enabled = cfg.enabled !== false;
    cfg.runEvery = clampNumber(cfg.runEvery, DEFAULTS.runEvery, 1, 1000);
    cfg.coreRoom = cfg.coreRoom ? normalizeRoomName(cfg.coreRoom) : DEFAULTS.coreRoom;
    cfg.storageFillThresholdPct = clampNumber(cfg.storageFillThresholdPct, DEFAULTS.storageFillThresholdPct, 0.5, 1);
    cfg.terminalFillThresholdPct = clampNumber(cfg.terminalFillThresholdPct, DEFAULTS.terminalFillThresholdPct, 0.5, 1);
    cfg.minSourceTerminalEnergyReserve = clampNumber(
        cfg.minSourceTerminalEnergyReserve,
        DEFAULTS.minSourceTerminalEnergyReserve,
        0,
        300000
    );
    cfg.minTargetTerminalFree = clampNumber(cfg.minTargetTerminalFree, DEFAULTS.minTargetTerminalFree, 0, 300000);
    cfg.minSendAmount = Math.floor(clampNumber(cfg.minSendAmount, DEFAULTS.minSendAmount, 100, 100000));
    cfg.maxSendAmount = Math.floor(clampNumber(cfg.maxSendAmount, DEFAULTS.maxSendAmount, cfg.minSendAmount, 300000));
    cfg.maxSendsPerTick = Math.floor(clampNumber(cfg.maxSendsPerTick, DEFAULTS.maxSendsPerTick, 1, 10));

    return cfg;
}

function shouldRunThisTick(interval) {
    if (interval <= 1) return true;
    return (Game.time % interval) === 0;
}

function getOwnedRooms() {
    const out = [];
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room || !room.controller || !room.controller.my) continue;
        out.push(room);
    }
    return out;
}

function pickCoreRoom(ownedRooms, cfg) {
    if (cfg.coreRoom) {
        const explicit = Game.rooms[cfg.coreRoom];
        if (explicit && explicit.controller && explicit.controller.my && explicit.terminal) return explicit;
    }

    let best = null;
    for (let i = 0; i < ownedRooms.length; i++) {
        const room = ownedRooms[i];
        if (!room || !room.terminal) continue;
        const rcl = room.controller && Number.isFinite(room.controller.level) ? room.controller.level : 0;
        const storageEnergy = room.storage && room.storage.store ? (room.storage.store[RESOURCE_ENERGY] || 0) : 0;
        if (!best) {
            best = { room, rcl, storageEnergy };
            continue;
        }
        if (rcl > best.rcl || (rcl === best.rcl && storageEnergy > best.storageEnergy) || (rcl === best.rcl && storageEnergy === best.storageEnergy && room.name < best.room.name)) {
            best = { room, rcl, storageEnergy };
        }
    }
    return best ? best.room : null;
}

function roomPressure(room, cfg) {
    const hasStorage = !!(room && room.storage && room.storage.store);
    const hasTerminal = !!(room && room.terminal && room.terminal.store);
    const storageUsed = hasStorage ? room.storage.store.getUsedCapacity() : 0;
    const storageCap = hasStorage ? room.storage.store.getCapacity() : 0;
    const terminalUsed = hasTerminal ? room.terminal.store.getUsedCapacity() : 0;
    const terminalCap = hasTerminal ? room.terminal.store.getCapacity() : 0;
    const storageFillPct = storageCap > 0 ? (storageUsed / storageCap) : 0;
    const terminalFillPct = terminalCap > 0 ? (terminalUsed / terminalCap) : 0;
    const terminalEnergy = hasTerminal ? (room.terminal.store[RESOURCE_ENERGY] || 0) : 0;

    const storageThresholdUsed = storageCap > 0 ? (storageCap * cfg.storageFillThresholdPct) : 0;
    const terminalThresholdUsed = terminalCap > 0 ? (terminalCap * cfg.terminalFillThresholdPct) : 0;
    const storageOverflow = Math.max(0, Math.floor(storageUsed - storageThresholdUsed));
    const terminalOverflow = Math.max(0, Math.floor(terminalUsed - terminalThresholdUsed));
    const pressure = storageOverflow + terminalOverflow;

    const terminalSpendable = Math.max(0, terminalEnergy - cfg.minSourceTerminalEnergyReserve);
    const underPressure = storageFillPct >= cfg.storageFillThresholdPct || terminalFillPct >= cfg.terminalFillThresholdPct;

    return {
        roomName: room.name,
        hasStorage,
        hasTerminal,
        storageUsed,
        storageCap,
        storageFillPct,
        terminalUsed,
        terminalCap,
        terminalFillPct,
        terminalEnergy,
        storageOverflow,
        terminalOverflow,
        pressure,
        terminalSpendable,
        terminalCooldown: hasTerminal ? room.terminal.cooldown : null,
        underPressure
    };
}

function solveAffordableAmount(fromRoomName, toRoomName, maxAmount, minAmount, sourceTerminalEnergy, reserve) {
    let cap = Math.floor(maxAmount);
    const min = Math.floor(minAmount);
    if (cap < min) return null;

    const step = 250;
    cap = Math.floor(cap / step) * step;
    if (cap < min) cap = min;

    for (let amount = cap; amount >= min; amount -= step) {
        const energyCost = Game.market ? Game.market.calcTransactionCost(amount, fromRoomName, toRoomName) : 0;
        const totalEnergyNeeded = amount + energyCost;
        if ((sourceTerminalEnergy - totalEnergyNeeded) < reserve) continue;
        return { amount, energyCost };
    }

    return null;
}

function recordTransfer(store, payload) {
    store.lastTransfers.unshift(payload);
    if (store.lastTransfers.length > 20) store.lastTransfers.length = 20;
}

module.exports = {
    getStore: function() {
        return ensureStore();
    },

    getConfig: function() {
        return ensureConfig();
    },

    run: function() {
        const store = ensureStore();
        const cfg = ensureConfig();
        const ownedRooms = getOwnedRooms();

        store.lastTick = Game.time;
        store.lastRooms = {};
        store.lastSummary = {
            enabled: !!cfg.enabled,
            coreRoom: cfg.coreRoom,
            runEvery: cfg.runEvery,
            roomsEvaluated: ownedRooms.length,
            pressuredRoomCount: 0,
            candidateCount: 0,
            sends: 0,
            reason: 'init'
        };

        if (!cfg.enabled) {
            store.lastSummary.reason = 'disabled';
            return store;
        }
        if (!shouldRunThisTick(cfg.runEvery)) {
            store.lastSummary.reason = `runEvery=${cfg.runEvery}`;
            return store;
        }
        if (ownedRooms.length < 2) {
            store.lastSummary.reason = 'need at least 2 owned rooms';
            return store;
        }

        const coreRoom = pickCoreRoom(ownedRooms, cfg);
        if (!coreRoom) {
            store.lastSummary.reason = 'no eligible core room with terminal';
            return store;
        }
        store.lastSummary.coreRoom = coreRoom.name;

        const coreTerminal = coreRoom.terminal;
        if (!coreTerminal || coreTerminal.store.getFreeCapacity() <= cfg.minTargetTerminalFree) {
            store.lastSummary.reason = 'core terminal lacks free capacity';
            return store;
        }

        let targetFree = coreTerminal.store.getFreeCapacity();
        const candidates = [];

        for (let i = 0; i < ownedRooms.length; i++) {
            const room = ownedRooms[i];
            const pressure = roomPressure(room, cfg);
            store.lastRooms[room.name] = pressure;

            if (pressure.underPressure) store.lastSummary.pressuredRoomCount += 1;
            if (room.name === coreRoom.name) continue;
            if (!pressure.hasTerminal) continue;
            if (pressure.terminalCooldown && pressure.terminalCooldown > 0) continue;
            if (!pressure.underPressure) continue;
            if (pressure.terminalSpendable < cfg.minSendAmount) continue;

            candidates.push(pressure);
        }

        if (candidates.length === 0) {
            store.lastSummary.reason = 'no source rooms match send criteria';
            return store;
        }

        candidates.sort((a, b) => {
            if (b.pressure !== a.pressure) return b.pressure - a.pressure;
            if (b.storageFillPct !== a.storageFillPct) return b.storageFillPct - a.storageFillPct;
            return b.terminalFillPct - a.terminalFillPct;
        });

        store.lastSummary.candidateCount = candidates.length;

        let sends = 0;
        for (let i = 0; i < candidates.length && sends < cfg.maxSendsPerTick; i++) {
            if (targetFree <= cfg.minTargetTerminalFree) break;

            const source = candidates[i];
            const freeForBalance = Math.max(0, targetFree - cfg.minTargetTerminalFree);
            if (freeForBalance < cfg.minSendAmount) break;

            const maxAmount = Math.min(cfg.maxSendAmount, source.terminalSpendable, freeForBalance);
            const solved = solveAffordableAmount(
                source.roomName,
                coreRoom.name,
                maxAmount,
                cfg.minSendAmount,
                source.terminalEnergy,
                cfg.minSourceTerminalEnergyReserve
            );
            if (!solved || solved.amount < cfg.minSendAmount) continue;

            const note = `zeadmin.balance:${source.roomName}->${coreRoom.name}@${Game.time}`;
            const result = managerTerminal.sendResource(
                source.roomName,
                coreRoom.name,
                RESOURCE_ENERGY,
                solved.amount,
                note
            );

            recordTransfer(store, {
                tick: Game.time,
                from: source.roomName,
                to: coreRoom.name,
                amount: solved.amount,
                estimatedEnergyCost: solved.energyCost,
                ok: !!(result && result.ok),
                error: result && result.ok ? null : (result && result.error ? result.error : 'unknown')
            });

            if (!result || !result.ok) continue;
            sends += 1;
            targetFree -= solved.amount;
        }

        store.lastSummary.sends = sends;
        store.lastSummary.reason = sends > 0 ? 'sent' : 'no successful sends';
        return store;
    }
};
