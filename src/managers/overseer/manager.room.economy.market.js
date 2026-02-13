const DEFAULTS = Object.freeze({
    enabled: true,
    runEvery: 25,
    minCredits: 5000,
    energyReserve: 20000,
    maxDealsPerRoom: 1
});

const DEFAULT_BUY = Object.freeze({
    target: 1500,
    batch: 500,
    maxPrice: 2.0
});

const DEFAULT_BASIC_BUY = Object.freeze({
    target: 1000,
    batch: 250,
    maxPrice: 1.0
});

const DEFAULT_SELL_ENERGY = Object.freeze({
    keep: 80000,
    batch: 5000,
    minPrice: 0.01
});

const BASIC_MINERALS = Object.freeze([
    RESOURCE_HYDROGEN,
    RESOURCE_OXYGEN,
    RESOURCE_UTRIUM,
    RESOURCE_LEMERGIUM,
    RESOURCE_KEANIUM,
    RESOURCE_ZYNTHIUM,
    RESOURCE_CATALYST
]);

const DEFAULT_TERMINAL_STOCK = Object.freeze(
    BASIC_MINERALS.reduce((acc, type) => {
        acc[type] = 1000;
        return acc;
    }, {
        [RESOURCE_LEMERGIUM_OXIDE]: 1000
    })
);

function clampNumber(value, fallback, min) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    if (num < min) return min;
    return num;
}

function ensureMarketConfig() {
    if (!Memory.market || typeof Memory.market !== 'object') Memory.market = {};
    const cfg = Memory.market;

    if (!cfg._initialized) {
        cfg.enabled = (typeof cfg.enabled === 'boolean') ? cfg.enabled : DEFAULTS.enabled;
        cfg.runEvery = clampNumber(cfg.runEvery, DEFAULTS.runEvery, 1);
        cfg.minCredits = clampNumber(cfg.minCredits, DEFAULTS.minCredits, 0);
        cfg.energyReserve = clampNumber(cfg.energyReserve, DEFAULTS.energyReserve, 0);
        cfg.maxDealsPerRoom = clampNumber(cfg.maxDealsPerRoom, DEFAULTS.maxDealsPerRoom, 0);
        if (!cfg.buy || typeof cfg.buy !== 'object') cfg.buy = {};
        if (!cfg.sell || typeof cfg.sell !== 'object') cfg.sell = {};
        if (!cfg.rooms || typeof cfg.rooms !== 'object') cfg.rooms = {};
        if (!cfg.terminalStock || typeof cfg.terminalStock !== 'object') cfg.terminalStock = {};
        if (!cfg.buy[RESOURCE_LEMERGIUM_OXIDE]) cfg.buy[RESOURCE_LEMERGIUM_OXIDE] = Object.assign({}, DEFAULT_BUY);
        BASIC_MINERALS.forEach(type => {
            if (!cfg.buy[type]) cfg.buy[type] = Object.assign({}, DEFAULT_BASIC_BUY);
        });
        if (!cfg.sell[RESOURCE_ENERGY]) cfg.sell[RESOURCE_ENERGY] = Object.assign({}, DEFAULT_SELL_ENERGY);
        for (const resourceType of Object.keys(DEFAULT_TERMINAL_STOCK)) {
            if (!(resourceType in cfg.terminalStock)) {
                cfg.terminalStock[resourceType] = DEFAULT_TERMINAL_STOCK[resourceType];
            }
        }
        cfg._initialized = true;
    }

    cfg.enabled = cfg.enabled !== false;
    cfg.runEvery = clampNumber(cfg.runEvery, DEFAULTS.runEvery, 1);
    cfg.minCredits = clampNumber(cfg.minCredits, DEFAULTS.minCredits, 0);
    cfg.energyReserve = clampNumber(cfg.energyReserve, DEFAULTS.energyReserve, 0);
    cfg.maxDealsPerRoom = clampNumber(cfg.maxDealsPerRoom, DEFAULTS.maxDealsPerRoom, 0);
    if (!cfg.buy || typeof cfg.buy !== 'object') cfg.buy = {};
    if (!cfg.sell || typeof cfg.sell !== 'object') cfg.sell = {};
    if (!cfg.rooms || typeof cfg.rooms !== 'object') cfg.rooms = {};
    if (!cfg.terminalStock || typeof cfg.terminalStock !== 'object') cfg.terminalStock = {};
    if (!cfg.buy[RESOURCE_LEMERGIUM_OXIDE]) cfg.buy[RESOURCE_LEMERGIUM_OXIDE] = Object.assign({}, DEFAULT_BUY);
    BASIC_MINERALS.forEach(type => {
        if (!cfg.buy[type]) cfg.buy[type] = Object.assign({}, DEFAULT_BASIC_BUY);
    });
    if (!cfg.sell[RESOURCE_ENERGY]) cfg.sell[RESOURCE_ENERGY] = Object.assign({}, DEFAULT_SELL_ENERGY);
    for (const resourceType of Object.keys(DEFAULT_TERMINAL_STOCK)) {
        if (!(resourceType in cfg.terminalStock)) {
            cfg.terminalStock[resourceType] = DEFAULT_TERMINAL_STOCK[resourceType];
        }
    }

    return cfg;
}

function mergePatch(target, patch) {
    if (!patch || typeof patch !== 'object') return target;
    for (const key of Object.keys(patch)) {
        const value = patch[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (!target[key] || typeof target[key] !== 'object') target[key] = {};
            mergePatch(target[key], value);
        } else {
            target[key] = value;
        }
    }
    return target;
}

function applyMarketPatch(patch) {
    const cfg = ensureMarketConfig();
    mergePatch(cfg, patch);
    return ensureMarketConfig();
}

function applyRoomPatch(roomName, patch) {
    const cfg = ensureMarketConfig();
    const key = ('' + roomName).trim();
    if (!key) return cfg;
    if (!cfg.rooms[key] || typeof cfg.rooms[key] !== 'object') cfg.rooms[key] = {};
    mergePatch(cfg.rooms[key], patch);
    return ensureMarketConfig();
}

function getRoomConfig(base, roomName) {
    const override = base.rooms && base.rooms[roomName];
    if (!override || typeof override !== 'object') return base;
    const merged = Object.assign({}, base, override);
    merged.buy = Object.assign({}, base.buy, override.buy);
    merged.sell = Object.assign({}, base.sell, override.sell);
    merged.terminalStock = Object.assign({}, base.terminalStock, override.terminalStock);
    return merged;
}

function getRoomTotals(room) {
    const totals = {};
    const addStore = (store) => {
        if (!store) return;
        for (const resourceType in store) {
            totals[resourceType] = (totals[resourceType] || 0) + store[resourceType];
        }
    };
    addStore(room.storage && room.storage.store);
    addStore(room.terminal && room.terminal.store);
    return totals;
}

function shouldRunThisTick(roomName, interval) {
    if (interval <= 1) return true;
    let hash = 0;
    for (let i = 0; i < roomName.length; i++) {
        hash = (hash + roomName.charCodeAt(i)) % interval;
    }
    return (Game.time % interval) === hash;
}

function normalizeBuySpec(spec) {
    const out = Object.assign({}, spec);
    out.target = clampNumber(out.target, 0, 0);
    out.batch = clampNumber(out.batch, Math.min(500, out.target || 500), 1);
    out.maxPrice = Number.isFinite(Number(out.maxPrice)) ? Number(out.maxPrice) : Infinity;
    out.enabled = out.enabled !== false;
    return out;
}

function normalizeSellSpec(spec) {
    const out = Object.assign({}, spec);
    out.keep = clampNumber(out.keep, 0, 0);
    out.batch = clampNumber(out.batch, 1000, 1);
    out.minPrice = Number.isFinite(Number(out.minPrice)) ? Number(out.minPrice) : 0;
    out.enabled = out.enabled !== false;
    return out;
}

function normalizeTerminalStock(stock) {
    const out = {};
    if (!stock || typeof stock !== 'object') return out;
    for (const resourceType of Object.keys(stock)) {
        const value = clampNumber(stock[resourceType], 0, 0);
        if (value > 0) out[resourceType] = value;
    }
    return out;
}

function getTrackedResources(cfg) {
    const keys = new Set();
    Object.keys(cfg.buy || {}).forEach(k => keys.add(k));
    Object.keys(cfg.sell || {}).forEach(k => keys.add(k));
    Object.keys(cfg.terminalStock || {}).forEach(k => keys.add(k));
    return Array.from(keys);
}

function getBestOrder(type, resourceType, roomName, priceLimit, descending) {
    if (!Game.market) return null;
    const orders = Game.market.getAllOrders({ type: type, resourceType: resourceType });
    if (!orders || orders.length === 0) return null;

    const myOrders = Game.market.orders || {};
    let best = null;
    for (const order of orders) {
        if (order.amount <= 0) continue;
        if (myOrders[order.id]) continue;
        if (Number.isFinite(priceLimit)) {
            if (descending && order.price < priceLimit) continue;
            if (!descending && order.price > priceLimit) continue;
        }
        if (!best) {
            best = order;
            continue;
        }
        if (descending) {
            if (order.price > best.price) best = order;
        } else {
            if (order.price < best.price) best = order;
        }
    }
    return best;
}

function tryBuy(room, cfg, totals) {
    if (!cfg.buy || typeof cfg.buy !== 'object') return false;
    if (Game.market.credits < cfg.minCredits) return false;

    const terminal = room.terminal;
    const energyAvailable = (terminal.store[RESOURCE_ENERGY] || 0) - cfg.energyReserve;
    if (energyAvailable <= 0) return false;

    const deficits = [];
    for (const resourceType of Object.keys(cfg.buy)) {
        const spec = normalizeBuySpec(cfg.buy[resourceType] || {});
        if (!spec.enabled || spec.target <= 0) continue;
        const total = totals[resourceType] || 0;
        const need = spec.target - total;
        if (need <= 0) continue;
        deficits.push({ resourceType, need, spec });
    }

    deficits.sort((a, b) => b.need - a.need);

    for (const entry of deficits) {
        const resourceType = entry.resourceType;
        const spec = entry.spec;
        const needed = entry.need;

        const order = getBestOrder(ORDER_SELL, resourceType, room.name, spec.maxPrice, false);
        if (!order) continue;

        let amount = Math.min(needed, spec.batch, order.amount);
        if (amount <= 0) continue;

        const cost = Game.market.calcTransactionCost(amount, room.name, order.roomName);
        if (cost > energyAvailable) {
            amount = Math.min(amount, Math.floor(energyAvailable / Math.max(1, cost / amount)));
        }
        if (amount <= 0) continue;

        const maxAffordable = Math.floor((Game.market.credits - cfg.minCredits) / order.price);
        if (maxAffordable <= 0) continue;
        if (amount > maxAffordable) amount = maxAffordable;

        const finalCost = Game.market.calcTransactionCost(amount, room.name, order.roomName);
        if (finalCost > energyAvailable) continue;

        const result = Game.market.deal(order.id, amount, room.name);
        if (result === OK) {
            debug('market', `[Market] ${room.name} bought ${amount} ${resourceType} @ ${order.price} (cost=${finalCost})`);
            return true;
        }
    }

    return false;
}

function trySell(room, cfg, totals) {
    if (!cfg.sell || typeof cfg.sell !== 'object') return false;
    const terminal = room.terminal;
    const energyAvailable = (terminal.store[RESOURCE_ENERGY] || 0) - cfg.energyReserve;
    if (energyAvailable <= 0) return false;

    for (const resourceType of Object.keys(cfg.sell)) {
        const spec = normalizeSellSpec(cfg.sell[resourceType] || {});
        if (!spec.enabled) continue;

        const total = totals[resourceType] || 0;
        const surplus = total - spec.keep;
        if (surplus <= 0) continue;

        let amount = Math.min(surplus, spec.batch, terminal.store[resourceType] || 0);
        if (amount <= 0) continue;

        const order = getBestOrder(ORDER_BUY, resourceType, room.name, spec.minPrice, true);
        if (!order) continue;

        if (order.amount < amount) amount = order.amount;
        if (amount <= 0) continue;

        const cost = Game.market.calcTransactionCost(amount, room.name, order.roomName);
        if (resourceType === RESOURCE_ENERGY) {
            if ((amount + cost) > energyAvailable) continue;
        } else if (cost > energyAvailable) {
            continue;
        }

        const result = Game.market.deal(order.id, amount, room.name);
        if (result === OK) {
            debug('market', `[Market] ${room.name} sold ${amount} ${resourceType} @ ${order.price} (cost=${cost})`);
            return true;
        }
    }

    return false;
}

function summarizeConfig(cfg) {
    const lines = [];
    lines.push(
        `Market auto=${cfg.enabled ? 'ON' : 'OFF'} runEvery=${cfg.runEvery} ` +
        `energyReserve=${cfg.energyReserve} minCredits=${cfg.minCredits} maxDeals=${cfg.maxDealsPerRoom}`
    );

    const buyKeys = Object.keys(cfg.buy || {}).sort();
    if (buyKeys.length > 0) {
        lines.push('Buy specs:');
        for (const resourceType of buyKeys) {
            const spec = normalizeBuySpec(cfg.buy[resourceType] || {});
            lines.push(
                `${resourceType}: enabled=${spec.enabled ? 'true' : 'false'} ` +
                `target=${spec.target} batch=${spec.batch} maxPrice=${spec.maxPrice}`
            );
        }
    } else {
        lines.push('Buy specs: (none)');
    }

    const sellKeys = Object.keys(cfg.sell || {}).sort();
    if (sellKeys.length > 0) {
        lines.push('Sell specs:');
        for (const resourceType of sellKeys) {
            const spec = normalizeSellSpec(cfg.sell[resourceType] || {});
            lines.push(
                `${resourceType}: enabled=${spec.enabled ? 'true' : 'false'} ` +
                `keep=${spec.keep} batch=${spec.batch} minPrice=${spec.minPrice}`
            );
        }
    } else {
        lines.push('Sell specs: (none)');
    }

    const stockKeys = Object.keys(cfg.terminalStock || {}).sort();
    if (stockKeys.length > 0) {
        lines.push('Terminal stock targets:');
        for (const resourceType of stockKeys) {
            const amount = clampNumber(cfg.terminalStock[resourceType], 0, 0);
            lines.push(`${resourceType}: ${amount}`);
        }
    } else {
        lines.push('Terminal stock targets: (none)');
    }

    return lines.join('\n');
}

const managerMarket = {
    getConfig: function() {
        return ensureMarketConfig();
    },

    applyPatch: function(patch) {
        return applyMarketPatch(patch);
    },

    applyRoomPatch: function(roomName, patch) {
        return applyRoomPatch(roomName, patch);
    },

    summarize: function() {
        const cfg = ensureMarketConfig();
        return summarizeConfig(cfg);
    },

    summarizeRoom: function(roomName) {
        const cfg = ensureMarketConfig();
        const merged = getRoomConfig(cfg, roomName);
        return summarizeConfig(merged);
    },

    getTerminalStockTargets: function(roomName) {
        const cfg = ensureMarketConfig();
        const merged = getRoomConfig(cfg, roomName);
        return normalizeTerminalStock(merged.terminalStock);
    },

    getTrackedResources: function(roomName) {
        const cfg = ensureMarketConfig();
        const merged = getRoomConfig(cfg, roomName);
        return getTrackedResources(merged);
    },

    run: function(room) {
        if (!Game.market) return;
        if (!room || !room.terminal) return;
        if (!room.controller || !room.controller.my) return;

        const base = ensureMarketConfig();
        if (!base.enabled) return;

        const cfg = getRoomConfig(base, room.name);
        if (!cfg.enabled) return;
        if (cfg.maxDealsPerRoom <= 0) return;
        if (room.terminal.cooldown && room.terminal.cooldown > 0) return;
        if (!shouldRunThisTick(room.name, cfg.runEvery)) return;

        if (room._state === 'EMERGENCY') return;

        const totals = getRoomTotals(room);

        if (tryBuy(room, cfg, totals)) return;
        trySell(room, cfg, totals);
    }
};

module.exports = managerMarket;
