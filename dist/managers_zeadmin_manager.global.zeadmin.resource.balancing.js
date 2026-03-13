const heap = require('utils_heap');
const managerTerminal = require('managers_structures_manager.terminal');

const STORE_KEY = 'zeadmin_resource_balancing';
const CONFIG_ROOT_KEY = 'resourceBalancing';

const BASIC_MINERALS = Object.freeze([
    RESOURCE_HYDROGEN,
    RESOURCE_OXYGEN,
    RESOURCE_LEMERGIUM,
    RESOURCE_ZYNTHIUM,
    RESOURCE_CATALYST
]);

const DEFAULT_CORE_STOCK_TARGETS = Object.freeze(
    BASIC_MINERALS.reduce((acc, type) => {
        acc[type] = 5000;
        return acc;
    }, {
        [RESOURCE_GHODIUM]: 5000
    })
);

const DEFAULT_SATELLITE_LAB_STOCK_TARGETS = Object.freeze(
    BASIC_MINERALS.reduce((acc, type) => {
        acc[type] = 1000;
        return acc;
    }, {
        [RESOURCE_GHODIUM]: 500
    })
);

const DEFAULTS = Object.freeze({
    enabled: true,
    runEvery: 5,
    coreRoom: null,
    stockTargetsEnabled: true,
    coreStockTargets: DEFAULT_CORE_STOCK_TARGETS,
    satelliteLabStockTargets: DEFAULT_SATELLITE_LAB_STOCK_TARGETS,
    satelliteNoLabExportTarget: 15000,
    noLabKeepPctWhenCoreDeficit: 0.75,
    noLabKeepPctWhenOverflow: 0.25,
    storageFillThresholdPct: 0.9,
    terminalFillThresholdPct: 0.9,
    minSourceTerminalEnergyReserve: 15000,
    minTargetTerminalFree: 10000,
    minSendAmount: 2000,
    maxSendAmount: 15000,
    maxEnergyCostPerUnit: 0.2,
    overflowMaxEnergyCostPerUnit: 0.35,
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

function clonePlain(obj) {
    if (!obj || typeof obj !== 'object') return {};
    return JSON.parse(JSON.stringify(obj));
}

function normalizeStockTargets(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (const resourceType in input) {
        if (!resourceType || resourceType === RESOURCE_ENERGY) continue;
        const qty = Math.floor(clampNumber(input[resourceType], 0, 0, 300000));
        if (qty > 0) out[resourceType] = qty;
    }
    return out;
}

function countLabs(room) {
    if (!room || typeof room.find !== 'function') return 0;
    const labs = room.find(FIND_MY_STRUCTURES, {
        filter: (s) => s && s.structureType === STRUCTURE_LAB
    });
    return labs ? labs.length : 0;
}

function getNativeMineralType(room) {
    if (!room || typeof room.find !== 'function') return null;
    const minerals = room.find(FIND_MINERALS);
    if (!minerals || minerals.length === 0) return null;
    return minerals[0] && minerals[0].mineralType ? minerals[0].mineralType : null;
}

function roomResourceTotal(room, resourceType) {
    if (!room || !resourceType) return 0;
    let total = 0;
    if (room.storage && room.storage.store) total += room.storage.store[resourceType] || 0;
    if (room.terminal && room.terminal.store) total += room.terminal.store[resourceType] || 0;
    return total;
}

function ensureMarketRoomsRoot() {
    if (!Memory.market || typeof Memory.market !== 'object') Memory.market = {};
    if (!Memory.market.rooms || typeof Memory.market.rooms !== 'object') Memory.market.rooms = {};
    return Memory.market.rooms;
}

function upsertRoomTerminalStockTargets(roomName, targets, managedResources) {
    const rooms = ensureMarketRoomsRoot();
    const key = normalizeRoomName(roomName);
    if (!rooms[key] || typeof rooms[key] !== 'object') rooms[key] = {};
    if (!rooms[key].terminalStockTargets || typeof rooms[key].terminalStockTargets !== 'object') {
        rooms[key].terminalStockTargets = {};
    }
    const terminalStockTargets = rooms[key].terminalStockTargets;

    let changes = 0;
    for (let i = 0; i < managedResources.length; i++) {
        const resourceType = managedResources[i];
        if (!resourceType || resourceType === RESOURCE_ENERGY) continue;

        const next = targets[resourceType] || 0;
        const prev = Number(terminalStockTargets[resourceType] || 0);

        if (next > 0) {
            if (prev !== next) {
                terminalStockTargets[resourceType] = next;
                changes += 1;
            }
            continue;
        }

        if (Object.prototype.hasOwnProperty.call(terminalStockTargets, resourceType)) {
            delete terminalStockTargets[resourceType];
            changes += 1;
        }
    }

    return changes;
}

function buildManagedResources(ownedRooms, cfg) {
    const set = {};
    for (const k in cfg.coreStockTargets) {
        if (k && k !== RESOURCE_ENERGY) set[k] = true;
    }
    for (const k in cfg.satelliteLabStockTargets) {
        if (k && k !== RESOURCE_ENERGY) set[k] = true;
    }
    for (let i = 0; i < ownedRooms.length; i++) {
        const room = ownedRooms[i];
        if (!room) continue;
        const mineralType = getNativeMineralType(room);
        if (mineralType && mineralType !== RESOURCE_ENERGY) set[mineralType] = true;
    }
    return Object.keys(set).sort();
}

function buildDesiredRoomTargets(roomMeta, coreRoomName, cfg) {
    const targets = {};
    if (!roomMeta || !roomMeta.room) return targets;
    const pressure = roomMeta.pressure || {};
    const labCount = Number.isFinite(roomMeta.labCount)
        ? roomMeta.labCount
        : (Number.isFinite(pressure.labCount) ? pressure.labCount : 0);
    const nativeMineralType = roomMeta.nativeMineralType || pressure.nativeMineralType || getNativeMineralType(roomMeta.room);

    if (roomMeta.room.name === coreRoomName) {
        return clonePlain(cfg.coreStockTargets);
    }

    if (labCount > 0) {
        return clonePlain(cfg.satelliteLabStockTargets);
    }

    if (nativeMineralType) {
        targets[nativeMineralType] = cfg.satelliteNoLabExportTarget;
    }
    return targets;
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
    cfg.stockTargetsEnabled = cfg.stockTargetsEnabled !== false;

    if (!cfg.coreStockTargets || typeof cfg.coreStockTargets !== 'object') {
        cfg.coreStockTargets = clonePlain(DEFAULTS.coreStockTargets);
    }
    if (!cfg.satelliteLabStockTargets || typeof cfg.satelliteLabStockTargets !== 'object') {
        cfg.satelliteLabStockTargets = clonePlain(DEFAULTS.satelliteLabStockTargets);
    }
    cfg.coreStockTargets = normalizeStockTargets(cfg.coreStockTargets);
    cfg.satelliteLabStockTargets = normalizeStockTargets(cfg.satelliteLabStockTargets);
    cfg.satelliteNoLabExportTarget = Math.floor(
        clampNumber(cfg.satelliteNoLabExportTarget, DEFAULTS.satelliteNoLabExportTarget, 0, 300000)
    );
    cfg.noLabKeepPctWhenCoreDeficit = clampNumber(
        cfg.noLabKeepPctWhenCoreDeficit,
        DEFAULTS.noLabKeepPctWhenCoreDeficit,
        0,
        1
    );
    cfg.noLabKeepPctWhenOverflow = clampNumber(
        cfg.noLabKeepPctWhenOverflow,
        DEFAULTS.noLabKeepPctWhenOverflow,
        0,
        cfg.noLabKeepPctWhenCoreDeficit
    );

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
    cfg.maxEnergyCostPerUnit = clampNumber(cfg.maxEnergyCostPerUnit, DEFAULTS.maxEnergyCostPerUnit, 0, 10);
    cfg.overflowMaxEnergyCostPerUnit = clampNumber(
        cfg.overflowMaxEnergyCostPerUnit,
        DEFAULTS.overflowMaxEnergyCostPerUnit,
        cfg.maxEnergyCostPerUnit,
        10
    );
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
        labCount: countLabs(room),
        nativeMineralType: getNativeMineralType(room),
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

function solveAffordableAmount(fromRoomName, toRoomName, resourceType, maxAmount, minAmount, sourceTerminalEnergy, reserve, maxCostPerUnit) {
    let cap = Math.floor(maxAmount);
    const min = Math.floor(minAmount);
    if (cap < min) return null;

    const step = 250;
    cap = Math.floor(cap / step) * step;
    if (cap < min) cap = min;

    for (let amount = cap; amount >= min; amount -= step) {
        const energyCost = Game.market ? Game.market.calcTransactionCost(amount, fromRoomName, toRoomName) : 0;
        const totalEnergyNeeded = resourceType === RESOURCE_ENERGY ? (amount + energyCost) : energyCost;
        if ((sourceTerminalEnergy - totalEnergyNeeded) < reserve) continue;
        const costPerUnit = amount > 0 ? (energyCost / amount) : Infinity;
        if (costPerUnit > maxCostPerUnit) continue;
        return { amount, energyCost, costPerUnit };
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
            basicMinerals: BASIC_MINERALS.slice(),
            basicMineralCount: BASIC_MINERALS.length,
            roomsEvaluated: ownedRooms.length,
            pressuredRoomCount: 0,
            stockTargetWrites: 0,
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

        const roomMetaByName = {};
        for (let i = 0; i < ownedRooms.length; i++) {
            const room = ownedRooms[i];
            const pressure = roomPressure(room, cfg);
            store.lastRooms[room.name] = pressure;
            if (pressure.underPressure) store.lastSummary.pressuredRoomCount += 1;
            roomMetaByName[room.name] = { room, pressure, desiredTargets: {} };
        }

        const managedResources = buildManagedResources(ownedRooms, cfg);
        store.lastSummary.managedResources = managedResources.slice(0, 20);
        store.lastSummary.managedResourceCount = managedResources.length;

        if (cfg.stockTargetsEnabled) {
            let writes = 0;
            for (let i = 0; i < ownedRooms.length; i++) {
                const room = ownedRooms[i];
                const meta = roomMetaByName[room.name];
                const desired = buildDesiredRoomTargets(meta, coreRoom.name, cfg);
                meta.desiredTargets = desired;
                writes += upsertRoomTerminalStockTargets(room.name, desired, managedResources);
            }
            store.lastSummary.stockTargetWrites = writes;
        }

        const coreTerminal = coreRoom.terminal;
        if (!coreTerminal || coreTerminal.store.getFreeCapacity() <= cfg.minTargetTerminalFree) {
            store.lastSummary.reason = 'core terminal lacks free capacity';
            return store;
        }

        let targetFree = coreTerminal.store.getFreeCapacity();
        const candidates = [];

        for (let i = 0; i < ownedRooms.length; i++) {
            const room = ownedRooms[i];
            if (room.name === coreRoom.name) continue;
            const meta = roomMetaByName[room.name];
            const pressure = meta.pressure;
            if (!pressure.hasTerminal) continue;
            if (pressure.terminalCooldown && pressure.terminalCooldown > 0) continue;

            const sourceTerminal = room.terminal;
            const sourceTerminalEnergy = sourceTerminal.store[RESOURCE_ENERGY] || 0;
            if (sourceTerminalEnergy <= cfg.minSourceTerminalEnergyReserve) continue;

            const sourceTargets = cfg.stockTargetsEnabled ? meta.desiredTargets : {};
            for (let r = 0; r < managedResources.length; r++) {
                const resourceType = managedResources[r];
                if (!resourceType || resourceType === RESOURCE_ENERGY) continue;

                const sourceTarget = sourceTargets[resourceType] || 0;
                const sourceTerminalAmount = sourceTerminal.store[resourceType] || 0;
                const sourceTotal = roomResourceTotal(room, resourceType);

                const coreTargets = cfg.stockTargetsEnabled
                    ? (roomMetaByName[coreRoom.name].desiredTargets || cfg.coreStockTargets)
                    : cfg.coreStockTargets;
                const coreTarget = coreTargets[resourceType] || 0;
                const coreTotal = roomResourceTotal(coreRoom, resourceType);
                const coreDeficit = Math.max(0, coreTarget - coreTotal);

                const shouldSendForDeficit = coreDeficit >= cfg.minSendAmount;
                const noLabRoom = pressure.labCount <= 0;

                let keepTarget = sourceTarget;
                if (noLabRoom && shouldSendForDeficit) {
                    keepTarget = Math.floor(sourceTarget * cfg.noLabKeepPctWhenCoreDeficit);
                }
                if (noLabRoom && pressure.underPressure) {
                    const keepUnderOverflow = Math.floor(sourceTarget * cfg.noLabKeepPctWhenOverflow);
                    if (keepUnderOverflow < keepTarget) keepTarget = keepUnderOverflow;
                }

                if (sourceTotal <= keepTarget) continue;
                const totalSurplus = sourceTotal - keepTarget;
                if (totalSurplus < cfg.minSendAmount) continue;

                const terminalSurplus = Math.max(0, sourceTerminalAmount - keepTarget);
                if (terminalSurplus < cfg.minSendAmount) continue;

                const shouldSendForOverflow = pressure.underPressure && totalSurplus >= cfg.minSendAmount;
                if (!shouldSendForDeficit && !shouldSendForOverflow) continue;

                const priority = shouldSendForDeficit ? 2 : 1;
                const maxByNeed = shouldSendForDeficit ? coreDeficit : totalSurplus;
                const maxAmount = Math.min(cfg.maxSendAmount, terminalSurplus, maxByNeed);
                if (maxAmount < cfg.minSendAmount) continue;

                candidates.push({
                    roomName: room.name,
                    pressure: pressure.pressure,
                    storageFillPct: pressure.storageFillPct,
                    terminalFillPct: pressure.terminalFillPct,
                    terminalEnergy: sourceTerminalEnergy,
                    sourceTarget,
                    sourceTotal,
                    terminalAmount: sourceTerminalAmount,
                    keepTarget,
                    noLabRoom,
                    resourceType,
                    coreDeficit,
                    priority,
                    maxAmount
                });
            }
        }

        if (candidates.length === 0) {
            store.lastSummary.reason = 'no source rooms match send criteria';
            return store;
        }

        candidates.sort((a, b) => {
            if (b.priority !== a.priority) return b.priority - a.priority;
            if (b.coreDeficit !== a.coreDeficit) return b.coreDeficit - a.coreDeficit;
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

            const maxAmount = Math.min(source.maxAmount, freeForBalance);
            const maxCpu = source.priority >= 2 ? cfg.maxEnergyCostPerUnit : cfg.overflowMaxEnergyCostPerUnit;
            const solved = solveAffordableAmount(
                source.roomName,
                coreRoom.name,
                source.resourceType,
                maxAmount,
                cfg.minSendAmount,
                source.terminalEnergy,
                cfg.minSourceTerminalEnergyReserve,
                maxCpu
            );
            if (!solved || solved.amount < cfg.minSendAmount) continue;

            const note = `zeadmin.balance:${source.resourceType}:${source.roomName}->${coreRoom.name}@${Game.time}`;
            const result = managerTerminal.sendResource(
                source.roomName,
                coreRoom.name,
                source.resourceType,
                solved.amount,
                note
            );

            recordTransfer(store, {
                tick: Game.time,
                from: source.roomName,
                to: coreRoom.name,
                resourceType: source.resourceType,
                amount: solved.amount,
                estimatedEnergyCost: solved.energyCost,
                costPerUnit: solved.costPerUnit,
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
