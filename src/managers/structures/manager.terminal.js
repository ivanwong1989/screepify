const DEFAULTS = Object.freeze({
    enabled: true,
    runEvery: 25,
    minCredits: 5000,
    energyReserve: 20000,
    terminalEnergyTarget: 60000,
    terminalEnergyMax: 80000,
    maxDealsPerRoom: 1,
    energyValue: 16,
    maxOverpayPct: 0.08,
    sellBufferPct: 0.05
});

const DEFAULT_BUY = Object.freeze({
    batch: 500,
    maxPrice: 2.0
});

const DEFAULT_BASIC_BUY = Object.freeze({
    batch: 250,
    maxPrice: 1.0
});

const DEFAULT_SELL_ENERGY = Object.freeze({
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

const DEFAULT_STOCK_TARGETS = Object.freeze(
    BASIC_MINERALS.reduce((acc, type) => {
        acc[type] = 1000;
        return acc;
    }, {
        [RESOURCE_LEMERGIUM_OXIDE]: 1500,
        [RESOURCE_ENERGY]: 80000
    })
);

function clampNumber(value, fallback, min) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    if (num < min) return min;
    return num;
}

function mergeLegacyStockTargets(cfg, stockTargets) {
    if (cfg.terminalStock && typeof cfg.terminalStock === 'object') {
        for (const resourceType of Object.keys(cfg.terminalStock)) {
            const value = clampNumber(cfg.terminalStock[resourceType], 0, 0);
            if (value > 0) {
                const current = clampNumber(stockTargets[resourceType], 0, 0);
                stockTargets[resourceType] = Math.max(current, value);
            }
        }
        delete cfg.terminalStock;
    }

    if (cfg.buy && typeof cfg.buy === 'object') {
        for (const resourceType of Object.keys(cfg.buy)) {
            const spec = cfg.buy[resourceType];
            if (!spec || typeof spec !== 'object' || !('target' in spec)) continue;
            const value = clampNumber(spec.target, 0, 0);
            if (value > 0) {
                const current = clampNumber(stockTargets[resourceType], 0, 0);
                stockTargets[resourceType] = Math.max(current, value);
            }
        }
    }

    if (cfg.sell && typeof cfg.sell === 'object') {
        for (const resourceType of Object.keys(cfg.sell)) {
            const spec = cfg.sell[resourceType];
            if (!spec || typeof spec !== 'object' || !('keep' in spec)) continue;
            const value = clampNumber(spec.keep, 0, 0);
            if (value > 0) {
                const current = clampNumber(stockTargets[resourceType], 0, 0);
                stockTargets[resourceType] = Math.max(current, value);
            }
        }
    }
}

function ensureMarketConfig() {
    if (!Memory.market || typeof Memory.market !== 'object') Memory.market = {};
    const cfg = Memory.market;

    if (!cfg._initialized) {
        cfg.enabled = (typeof cfg.enabled === 'boolean') ? cfg.enabled : DEFAULTS.enabled;
        cfg.runEvery = clampNumber(cfg.runEvery, DEFAULTS.runEvery, 1);
        cfg.minCredits = clampNumber(cfg.minCredits, DEFAULTS.minCredits, 0);
        cfg.energyReserve = clampNumber(cfg.energyReserve, DEFAULTS.energyReserve, 0);
        cfg.terminalEnergyTarget = clampNumber(cfg.terminalEnergyTarget, DEFAULTS.terminalEnergyTarget, 0);
        cfg.terminalEnergyMax = clampNumber(cfg.terminalEnergyMax, DEFAULTS.terminalEnergyMax, 0);
        cfg.maxDealsPerRoom = clampNumber(cfg.maxDealsPerRoom, DEFAULTS.maxDealsPerRoom, 0);
        cfg.energyValue = clampNumber(cfg.energyValue, DEFAULTS.energyValue, 0);
        cfg.maxOverpayPct = clampNumber(cfg.maxOverpayPct, DEFAULTS.maxOverpayPct, 0);
        cfg.sellBufferPct = clampNumber(cfg.sellBufferPct, DEFAULTS.sellBufferPct, 0);
        if (!cfg.buy || typeof cfg.buy !== 'object') cfg.buy = {};
        if (!cfg.sell || typeof cfg.sell !== 'object') cfg.sell = {};
        if (!cfg.rooms || typeof cfg.rooms !== 'object') cfg.rooms = {};
        if (!cfg.stockTargets || typeof cfg.stockTargets !== 'object') cfg.stockTargets = {};
        if (!cfg.buy[RESOURCE_LEMERGIUM_OXIDE]) cfg.buy[RESOURCE_LEMERGIUM_OXIDE] = Object.assign({}, DEFAULT_BUY);
        BASIC_MINERALS.forEach(type => {
            if (!cfg.buy[type]) cfg.buy[type] = Object.assign({}, DEFAULT_BASIC_BUY);
        });
        if (!cfg.sell[RESOURCE_ENERGY]) cfg.sell[RESOURCE_ENERGY] = Object.assign({}, DEFAULT_SELL_ENERGY);
        for (const resourceType of Object.keys(DEFAULT_STOCK_TARGETS)) {
            if (!(resourceType in cfg.stockTargets)) {
                cfg.stockTargets[resourceType] = DEFAULT_STOCK_TARGETS[resourceType];
            }
        }
        mergeLegacyStockTargets(cfg, cfg.stockTargets);
        cfg._initialized = true;
    }

    cfg.enabled = cfg.enabled !== false;
    cfg.runEvery = clampNumber(cfg.runEvery, DEFAULTS.runEvery, 1);
    cfg.minCredits = clampNumber(cfg.minCredits, DEFAULTS.minCredits, 0);
    cfg.energyReserve = clampNumber(cfg.energyReserve, DEFAULTS.energyReserve, 0);
    cfg.terminalEnergyTarget = clampNumber(cfg.terminalEnergyTarget, DEFAULTS.terminalEnergyTarget, 0);
    cfg.terminalEnergyMax = clampNumber(cfg.terminalEnergyMax, DEFAULTS.terminalEnergyMax, 0);
    cfg.maxDealsPerRoom = clampNumber(cfg.maxDealsPerRoom, DEFAULTS.maxDealsPerRoom, 0);
    cfg.energyValue = clampNumber(cfg.energyValue, DEFAULTS.energyValue, 0);
    cfg.maxOverpayPct = clampNumber(cfg.maxOverpayPct, DEFAULTS.maxOverpayPct, 0);
    cfg.sellBufferPct = clampNumber(cfg.sellBufferPct, DEFAULTS.sellBufferPct, 0);
    if (!cfg.buy || typeof cfg.buy !== 'object') cfg.buy = {};
    if (!cfg.sell || typeof cfg.sell !== 'object') cfg.sell = {};
    if (!cfg.rooms || typeof cfg.rooms !== 'object') cfg.rooms = {};
    if (!cfg.stockTargets || typeof cfg.stockTargets !== 'object') cfg.stockTargets = {};
    if (!cfg.buy[RESOURCE_LEMERGIUM_OXIDE]) cfg.buy[RESOURCE_LEMERGIUM_OXIDE] = Object.assign({}, DEFAULT_BUY);
    BASIC_MINERALS.forEach(type => {
        if (!cfg.buy[type]) cfg.buy[type] = Object.assign({}, DEFAULT_BASIC_BUY);
    });
    if (!cfg.sell[RESOURCE_ENERGY]) cfg.sell[RESOURCE_ENERGY] = Object.assign({}, DEFAULT_SELL_ENERGY);
    for (const resourceType of Object.keys(DEFAULT_STOCK_TARGETS)) {
        if (!(resourceType in cfg.stockTargets)) {
            cfg.stockTargets[resourceType] = DEFAULT_STOCK_TARGETS[resourceType];
        }
    }
    mergeLegacyStockTargets(cfg, cfg.stockTargets);

    if (cfg.rooms && typeof cfg.rooms === 'object') {
        for (const roomName of Object.keys(cfg.rooms)) {
            const roomCfg = cfg.rooms[roomName];
            if (!roomCfg || typeof roomCfg !== 'object') continue;
            if (!roomCfg.stockTargets || typeof roomCfg.stockTargets !== 'object') roomCfg.stockTargets = {};
            mergeLegacyStockTargets(roomCfg, roomCfg.stockTargets);
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
    merged.stockTargets = Object.assign({}, base.stockTargets, override.stockTargets);
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

function getTerminalTotals(room) {
    const totals = {};
    if (!room || !room.terminal || !room.terminal.store) return totals;
    const store = room.terminal.store;
    for (const resourceType in store) {
        totals[resourceType] = (totals[resourceType] || 0) + store[resourceType];
    }
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
    out.batch = clampNumber(out.batch, 500, 1);
    out.maxPrice = Number.isFinite(Number(out.maxPrice)) ? Number(out.maxPrice) : Infinity;
    out.enabled = out.enabled !== false;
    return out;
}

function normalizeSellSpec(spec) {
    const out = Object.assign({}, spec);
    out.batch = clampNumber(out.batch, 1000, 1);
    out.minPrice = Number.isFinite(Number(out.minPrice)) ? Number(out.minPrice) : 0;
    out.enabled = out.enabled !== false;
    return out;
}

function normalizeStockTargets(stock) {
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
    Object.keys(cfg.stockTargets || {}).forEach(k => keys.add(k));
    return Array.from(keys);
}

function getStockTargetsFromConfig(cfg) {
    const targets = normalizeStockTargets(cfg.stockTargets);
    if (cfg.buy && typeof cfg.buy === 'object') {
        for (const resourceType of Object.keys(cfg.buy)) {
            const spec = cfg.buy[resourceType];
            if (!spec || typeof spec !== 'object' || !('target' in spec)) continue;
            const value = clampNumber(spec.target, 0, 0);
            if (value > 0) {
                targets[resourceType] = Math.max(targets[resourceType] || 0, value);
            }
        }
    }
    if (cfg.sell && typeof cfg.sell === 'object') {
        for (const resourceType of Object.keys(cfg.sell)) {
            const spec = cfg.sell[resourceType];
            if (!spec || typeof spec !== 'object' || !('keep' in spec)) continue;
            const value = clampNumber(spec.keep, 0, 0);
            if (value > 0) {
                targets[resourceType] = Math.max(targets[resourceType] || 0, value);
            }
        }
    }
    if (cfg.terminalStock && typeof cfg.terminalStock === 'object') {
        for (const resourceType of Object.keys(cfg.terminalStock)) {
            const value = clampNumber(cfg.terminalStock[resourceType], 0, 0);
            if (value > 0) {
                targets[resourceType] = Math.max(targets[resourceType] || 0, value);
            }
        }
    }
    return targets;
}

function calcEffectiveBuy(order, amount, roomName, energyValue) {
    const energyCost = Game.market.calcTransactionCost(amount, roomName, order.roomName);
    const effectivePrice = order.price + (energyCost * energyValue) / Math.max(1, amount);
    return { energyCost, effectivePrice };
}

function calcEffectiveSell(order, amount, roomName, energyValue) {
    const energyCost = Game.market.calcTransactionCost(amount, roomName, order.roomName);
    const effectivePrice = order.price - (energyCost * energyValue) / Math.max(1, amount);
    return { energyCost, effectivePrice };
}

function formatNumber(value, digits) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '' + value;
    const places = Number.isFinite(digits) ? digits : 3;
    return num.toFixed(places);
}

function formatAmountSteps(steps) {
    if (!steps || steps.length === 0) return '';
    return steps.map(step => `${step.label}=${step.amount}`).join(' -> ');
}

function getRunStatus(room, cfg) {
    const reasons = [];
    if (!Game.market) reasons.push('no market');
    if (!room) reasons.push('no room');
    if (room && !room.terminal) reasons.push('no terminal');
    if (room && (!room.controller || !room.controller.my)) reasons.push('not owned');
    if (!cfg.enabled) reasons.push('disabled');
    if (cfg.maxDealsPerRoom <= 0) reasons.push('maxDealsPerRoom=0');
    if (room && room.terminal && room.terminal.cooldown && room.terminal.cooldown > 0) {
        reasons.push(`terminal cooldown=${room.terminal.cooldown}`);
    }
    if (room && !shouldRunThisTick(room.name, cfg.runEvery)) {
        reasons.push(`runEvery=${cfg.runEvery} not scheduled`);
    }
    if (room && room._state === 'EMERGENCY') reasons.push('room emergency');
    return { ok: reasons.length === 0, reasons };
}

function buildBuyExplanation(room, cfg, totals) {
    const lines = [];
    if (!cfg.buy || typeof cfg.buy !== 'object') {
        lines.push('Buy: no buy config');
        return lines;
    }
    if (Game.market.credits < cfg.minCredits) {
        lines.push(`Buy: blocked (credits=${Game.market.credits} < minCredits=${cfg.minCredits})`);
        return lines;
    }
    const terminal = room.terminal;
    const energyAvailable = (terminal.store[RESOURCE_ENERGY] || 0) - cfg.energyReserve;
    if (energyAvailable <= 0) {
        lines.push(`Buy: blocked (energyAvailable=${energyAvailable} <= 0, energyReserve=${cfg.energyReserve})`);
        return lines;
    }

    const stockTargets = getStockTargetsFromConfig(cfg);
    const creditsAvailable = Game.market.credits - cfg.minCredits;

    const deficits = [];
    for (const resourceType of Object.keys(cfg.buy)) {
        const spec = normalizeBuySpec(cfg.buy[resourceType] || {});
        if (!spec.enabled) continue;
        const target = stockTargets[resourceType] || 0;
        if (target <= 0) continue;
        const total = totals[resourceType] || 0;
        const need = target - total;
        if (need <= 0) continue;
        deficits.push({ resourceType, need, spec, target, total });
    }

    if (deficits.length === 0) {
        lines.push('Buy: no deficits');
        return lines;
    }

    deficits.sort((a, b) => b.need - a.need);
    const deficitSummary = deficits.slice(0, 8).map(entry => {
        return `${entry.resourceType} need=${entry.need} target=${entry.target} total=${entry.total}`;
    }).join(' | ');
    lines.push(`Buy: creditsAvailable=${creditsAvailable} energyAvailable=${energyAvailable} (reserve=${cfg.energyReserve})`);
    lines.push('Buy formula: effectivePrice = order.price + (energyCost * energyValue) / amount');
    lines.push(`Buy deficits (sorted): ${deficitSummary}${deficits.length > 8 ? ` (+${deficits.length - 8} more)` : ''}`);

    for (const entry of deficits) {
        const resourceType = entry.resourceType;
        const spec = entry.spec;
        const needed = entry.need;

        const orders = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: resourceType }) || [];
        if (orders.length === 0) {
            lines.push(`Buy ${resourceType}: no sell orders`);
            continue;
        }

        const maxPrice = Number.isFinite(spec.maxPrice) ? spec.maxPrice : Infinity;
        const priceLimit = Number.isFinite(maxPrice) ? maxPrice * (1 + cfg.maxOverpayPct) : Infinity;
        const myOrders = Game.market.orders || {};
        let best = null;
        const skipped = {
            myOrder: 0,
            price: 0,
            amount: 0,
            energy: 0,
            credits: 0,
            effPrice: 0
        };

        for (const order of orders) {
            if (order.amount <= 0) {
                skipped.amount += 1;
                continue;
            }
            if (myOrders[order.id]) {
                skipped.myOrder += 1;
                continue;
            }
            if (order.price > priceLimit) {
                skipped.price += 1;
                continue;
            }

            let amount = Math.min(needed, spec.batch, order.amount);
            if (amount <= 0) {
                skipped.amount += 1;
                continue;
            }
            const steps = [{ label: 'base', amount }];

            let result = calcEffectiveBuy(order, amount, room.name, cfg.energyValue);
            if (result.energyCost > energyAvailable) {
                const perUnitCost = result.energyCost / amount;
                amount = Math.floor(energyAvailable / perUnitCost);
                if (amount <= 0) {
                    skipped.energy += 1;
                    continue;
                }
                steps.push({ label: 'energy', amount });
                result = calcEffectiveBuy(order, amount, room.name, cfg.energyValue);
                if (result.energyCost > energyAvailable) {
                    skipped.energy += 1;
                    continue;
                }
            }

            if (creditsAvailable <= 0) {
                skipped.credits += 1;
                continue;
            }
            const maxAffordable = Math.floor(creditsAvailable / order.price);
            if (maxAffordable <= 0) {
                skipped.credits += 1;
                continue;
            }
            if (amount > maxAffordable) {
                amount = maxAffordable;
                if (amount <= 0) {
                    skipped.credits += 1;
                    continue;
                }
                steps.push({ label: 'credits', amount });
                result = calcEffectiveBuy(order, amount, room.name, cfg.energyValue);
                if (result.energyCost > energyAvailable) {
                    skipped.energy += 1;
                    continue;
                }
            }

            if (result.effectivePrice > priceLimit) {
                skipped.effPrice += 1;
                continue;
            }

            if (!best || result.effectivePrice < best.effectivePrice) {
                best = {
                    order,
                    amount,
                    energyCost: result.energyCost,
                    effectivePrice: result.effectivePrice,
                    steps,
                    priceLimit
                };
            }
        }

        if (!best) {
            lines.push(`Buy ${resourceType}: no viable orders (orders=${orders.length} skip my=${skipped.myOrder} price=${skipped.price} amount=${skipped.amount} energy=${skipped.energy} credits=${skipped.credits} eff=${skipped.effPrice})`);
            continue;
        }

        const eff = formatNumber(best.effectivePrice, 3);
        const limit = Number.isFinite(best.priceLimit) ? formatNumber(best.priceLimit, 3) : 'Infinity';
        lines.push(`Buy candidate: ${resourceType} need=${needed} batch=${spec.batch} maxPrice=${spec.maxPrice} priceLimit=${limit}`);
        lines.push(`Best buy: id=${best.order.id} room=${best.order.roomName} price=${best.order.price} amount=${best.amount} energyCost=${best.energyCost} energyValue=${cfg.energyValue} eff=${eff}`);
        lines.push(`Amount calc: ${formatAmountSteps(best.steps)} | priceLimit=${limit}`);
        lines.push(`Orders checked=${orders.length} skipped my=${skipped.myOrder} price=${skipped.price} amount=${skipped.amount} energy=${skipped.energy} credits=${skipped.credits} eff=${skipped.effPrice}`);
        return lines;
    }

    return lines;
}

function buildSellExplanation(room, cfg, totals) {
    const lines = [];
    if (!cfg.sell || typeof cfg.sell !== 'object') {
        lines.push('Sell: no sell config');
        return lines;
    }

    const terminal = room.terminal;
    const energyAvailable = (terminal.store[RESOURCE_ENERGY] || 0) - cfg.energyReserve;
    if (energyAvailable <= 0) {
        lines.push(`Sell: blocked (energyAvailable=${energyAvailable} <= 0, energyReserve=${cfg.energyReserve})`);
        return lines;
    }

    const stockTargets = getStockTargetsFromConfig(cfg);
    const myOrders = Game.market.orders || {};

    lines.push(`Sell: energyAvailable=${energyAvailable} (reserve=${cfg.energyReserve})`);
    lines.push('Sell formula: effectivePrice = order.price - (energyCost * energyValue) / amount');

    for (const resourceType of Object.keys(cfg.sell)) {
        const spec = normalizeSellSpec(cfg.sell[resourceType] || {});
        if (!spec.enabled) continue;

        const target = stockTargets[resourceType] || 0;
        const total = totals[resourceType] || 0;
        const threshold = target * (1 + cfg.sellBufferPct);
        const surplus = total - threshold;
        if (surplus <= 0) continue;

        const terminalAmount = terminal.store[resourceType] || 0;
        if (terminalAmount <= 0) continue;

        const orders = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: resourceType }) || [];
        if (orders.length === 0) {
            lines.push(`Sell ${resourceType}: no buy orders`);
            continue;
        }

        let best = null;
        const skipped = {
            myOrder: 0,
            price: 0,
            amount: 0,
            energy: 0,
            effPrice: 0
        };

        for (const order of orders) {
            if (order.amount <= 0) {
                skipped.amount += 1;
                continue;
            }
            if (myOrders[order.id]) {
                skipped.myOrder += 1;
                continue;
            }
            if (order.price < spec.minPrice) {
                skipped.price += 1;
                continue;
            }

            let amount = Math.min(surplus, spec.batch, terminalAmount, order.amount);
            if (amount <= 0) {
                skipped.amount += 1;
                continue;
            }
            const steps = [{ label: 'base', amount }];

            let result = calcEffectiveSell(order, amount, room.name, cfg.energyValue);

            if (resourceType === RESOURCE_ENERGY) {
                if ((amount + result.energyCost) > energyAvailable) {
                    const perUnitCost = result.energyCost / amount;
                    const maxByEnergy = Math.floor(energyAvailable / (1 + perUnitCost));
                    if (maxByEnergy <= 0) {
                        skipped.energy += 1;
                        continue;
                    }
                    amount = Math.min(amount, maxByEnergy);
                    steps.push({ label: 'energy', amount });
                    result = calcEffectiveSell(order, amount, room.name, cfg.energyValue);
                    if ((amount + result.energyCost) > energyAvailable) {
                        skipped.energy += 1;
                        continue;
                    }
                }

                const perUnitCost = result.energyCost / amount;
                const maxByThreshold = Math.floor(surplus / (1 + perUnitCost));
                if (maxByThreshold <= 0) {
                    skipped.amount += 1;
                    continue;
                }
                if (amount > maxByThreshold) {
                    amount = maxByThreshold;
                    steps.push({ label: 'threshold', amount });
                    if (amount <= 0) {
                        skipped.amount += 1;
                        continue;
                    }
                    result = calcEffectiveSell(order, amount, room.name, cfg.energyValue);
                    if ((amount + result.energyCost) > energyAvailable) {
                        skipped.energy += 1;
                        continue;
                    }
                }
            } else if (result.energyCost > energyAvailable) {
                const perUnitCost = result.energyCost / amount;
                amount = Math.floor(energyAvailable / perUnitCost);
                if (amount <= 0) {
                    skipped.energy += 1;
                    continue;
                }
                steps.push({ label: 'energy', amount });
                result = calcEffectiveSell(order, amount, room.name, cfg.energyValue);
                if (result.energyCost > energyAvailable) {
                    skipped.energy += 1;
                    continue;
                }
            }

            if (amount <= 0) {
                skipped.amount += 1;
                continue;
            }
            if (result.effectivePrice < spec.minPrice) {
                skipped.effPrice += 1;
                continue;
            }

            if (!best || result.effectivePrice > best.effectivePrice) {
                best = {
                    order,
                    amount,
                    energyCost: result.energyCost,
                    effectivePrice: result.effectivePrice,
                    steps
                };
            }
        }

        if (!best) {
            lines.push(`Sell ${resourceType}: no viable orders (orders=${orders.length} skip my=${skipped.myOrder} price=${skipped.price} amount=${skipped.amount} energy=${skipped.energy} eff=${skipped.effPrice})`);
            continue;
        }

        const eff = formatNumber(best.effectivePrice, 3);
        lines.push(`Sell candidate: ${resourceType} surplus=${surplus} threshold=${formatNumber(threshold, 2)} terminal=${terminalAmount} batch=${spec.batch} minPrice=${spec.minPrice}`);
        lines.push(`Best sell: id=${best.order.id} room=${best.order.roomName} price=${best.order.price} amount=${best.amount} energyCost=${best.energyCost} energyValue=${cfg.energyValue} eff=${eff}`);
        lines.push(`Amount calc: ${formatAmountSteps(best.steps)}`);
        lines.push(`Orders checked=${orders.length} skipped my=${skipped.myOrder} price=${skipped.price} amount=${skipped.amount} energy=${skipped.energy} eff=${skipped.effPrice}`);
        return lines;
    }

    lines.push('Sell: no surpluses or no viable orders');
    return lines;
}

function tryBuy(room, cfg, totals) {
    if (!cfg.buy || typeof cfg.buy !== 'object') return false;
    if (Game.market.credits < cfg.minCredits) return false;

    const terminal = room.terminal;
    const energyAvailable = (terminal.store[RESOURCE_ENERGY] || 0) - cfg.energyReserve;
    if (energyAvailable <= 0) return false;

    const stockTargets = getStockTargetsFromConfig(cfg);
    const creditsAvailable = Game.market.credits - cfg.minCredits;

    const deficits = [];
    for (const resourceType of Object.keys(cfg.buy)) {
        const spec = normalizeBuySpec(cfg.buy[resourceType] || {});
        if (!spec.enabled) continue;
        const target = stockTargets[resourceType] || 0;
        if (target <= 0) continue;
        const total = totals[resourceType] || 0;
        const need = target - total;
        if (need <= 0) continue;
        deficits.push({ resourceType, need, spec });
    }

    deficits.sort((a, b) => b.need - a.need);

    for (const entry of deficits) {
        const resourceType = entry.resourceType;
        const spec = entry.spec;
        const needed = entry.need;

        const orders = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: resourceType });
        if (!orders || orders.length === 0) continue;

        const maxPrice = Number.isFinite(spec.maxPrice) ? spec.maxPrice : Infinity;
        const priceLimit = Number.isFinite(maxPrice) ? maxPrice * (1 + cfg.maxOverpayPct) : Infinity;
        const myOrders = Game.market.orders || {};
        let best = null;

        for (const order of orders) {
            if (order.amount <= 0) continue;
            if (myOrders[order.id]) continue;
            if (order.price > priceLimit) continue;

            let amount = Math.min(needed, spec.batch, order.amount);
            if (amount <= 0) continue;

            let result = calcEffectiveBuy(order, amount, room.name, cfg.energyValue);
            if (result.energyCost > energyAvailable) {
                const perUnitCost = result.energyCost / amount;
                amount = Math.floor(energyAvailable / perUnitCost);
                if (amount <= 0) continue;
                result = calcEffectiveBuy(order, amount, room.name, cfg.energyValue);
                if (result.energyCost > energyAvailable) continue;
            }

            if (creditsAvailable <= 0) continue;
            const maxAffordable = Math.floor(creditsAvailable / order.price);
            if (maxAffordable <= 0) continue;
            if (amount > maxAffordable) {
                amount = maxAffordable;
                if (amount <= 0) continue;
                result = calcEffectiveBuy(order, amount, room.name, cfg.energyValue);
                if (result.energyCost > energyAvailable) continue;
            }

            if (result.effectivePrice > priceLimit) continue;

            if (!best || result.effectivePrice < best.effectivePrice) {
                best = { order, amount, energyCost: result.energyCost, effectivePrice: result.effectivePrice };
            }
        }

        if (best) {
            const result = Game.market.deal(best.order.id, best.amount, room.name);
            if (result === OK) {
                const eff = Number.isFinite(best.effectivePrice) ? best.effectivePrice.toFixed(3) : best.effectivePrice;
                debug('market', `[Market] ${room.name} bought ${best.amount} ${resourceType} @ ${best.order.price} (eff=${eff} energy=${best.energyCost})`);
                return true;
            }
        }
    }

    return false;
}

function trySell(room, cfg, totals) {
    if (!cfg.sell || typeof cfg.sell !== 'object') return false;
    const terminal = room.terminal;
    const energyAvailable = (terminal.store[RESOURCE_ENERGY] || 0) - cfg.energyReserve;
    if (energyAvailable <= 0) return false;

    const stockTargets = getStockTargetsFromConfig(cfg);
    const myOrders = Game.market.orders || {};

    for (const resourceType of Object.keys(cfg.sell)) {
        const spec = normalizeSellSpec(cfg.sell[resourceType] || {});
        if (!spec.enabled) continue;

        const target = stockTargets[resourceType] || 0;
        const total = totals[resourceType] || 0;
        const threshold = target * (1 + cfg.sellBufferPct);
        const surplus = total - threshold;
        if (surplus <= 0) continue;

        const terminalAmount = terminal.store[resourceType] || 0;
        if (terminalAmount <= 0) continue;

        const orders = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: resourceType });
        if (!orders || orders.length === 0) continue;

        let best = null;
        for (const order of orders) {
            if (order.amount <= 0) continue;
            if (myOrders[order.id]) continue;
            if (order.price < spec.minPrice) continue;

            let amount = Math.min(surplus, spec.batch, terminalAmount, order.amount);
            if (amount <= 0) continue;

            let result = calcEffectiveSell(order, amount, room.name, cfg.energyValue);

            if (resourceType === RESOURCE_ENERGY) {
                if ((amount + result.energyCost) > energyAvailable) {
                    const perUnitCost = result.energyCost / amount;
                    const maxByEnergy = Math.floor(energyAvailable / (1 + perUnitCost));
                    if (maxByEnergy <= 0) continue;
                    amount = Math.min(amount, maxByEnergy);
                    result = calcEffectiveSell(order, amount, room.name, cfg.energyValue);
                    if ((amount + result.energyCost) > energyAvailable) continue;
                }

                const perUnitCost = result.energyCost / amount;
                const maxByThreshold = Math.floor(surplus / (1 + perUnitCost));
                if (maxByThreshold <= 0) continue;
                if (amount > maxByThreshold) {
                    amount = maxByThreshold;
                    if (amount <= 0) continue;
                    result = calcEffectiveSell(order, amount, room.name, cfg.energyValue);
                    if ((amount + result.energyCost) > energyAvailable) continue;
                }
            } else if (result.energyCost > energyAvailable) {
                const perUnitCost = result.energyCost / amount;
                amount = Math.floor(energyAvailable / perUnitCost);
                if (amount <= 0) continue;
                result = calcEffectiveSell(order, amount, room.name, cfg.energyValue);
                if (result.energyCost > energyAvailable) continue;
            }

            if (amount <= 0) continue;
            if (result.effectivePrice < spec.minPrice) continue;

            if (!best || result.effectivePrice > best.effectivePrice) {
                best = { order, amount, energyCost: result.energyCost, effectivePrice: result.effectivePrice };
            }
        }

        if (best) {
            const result = Game.market.deal(best.order.id, best.amount, room.name);
            if (result === OK) {
                const eff = Number.isFinite(best.effectivePrice) ? best.effectivePrice.toFixed(3) : best.effectivePrice;
                debug('market', `[Market] ${room.name} sold ${best.amount} ${resourceType} @ ${best.order.price} (eff=${eff} energy=${best.energyCost})`);
                return true;
            }
        }
    }

    return false;
}

function summarizeConfig(cfg) {
    const lines = [];
    lines.push(
        `Market auto=${cfg.enabled ? 'ON' : 'OFF'} runEvery=${cfg.runEvery} ` +
        `energyReserve=${cfg.energyReserve} terminalEnergyTarget=${cfg.terminalEnergyTarget} terminalEnergyMax=${cfg.terminalEnergyMax} ` +
        `minCredits=${cfg.minCredits} maxDeals=${cfg.maxDealsPerRoom} ` +
        `energyValue=${cfg.energyValue} maxOverpayPct=${cfg.maxOverpayPct} sellBufferPct=${cfg.sellBufferPct}`
    );

    const buyKeys = Object.keys(cfg.buy || {}).sort();
    if (buyKeys.length > 0) {
        lines.push('Buy specs:');
        for (const resourceType of buyKeys) {
            const spec = normalizeBuySpec(cfg.buy[resourceType] || {});
            lines.push(
                `${resourceType}: enabled=${spec.enabled ? 'true' : 'false'} ` +
                `batch=${spec.batch} maxPrice=${spec.maxPrice}`
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
                `batch=${spec.batch} minPrice=${spec.minPrice}`
            );
        }
    } else {
        lines.push('Sell specs: (none)');
    }

    const stockTargets = getStockTargetsFromConfig(cfg);
    const stockKeys = Object.keys(stockTargets || {}).sort();
    if (stockKeys.length > 0) {
        lines.push('Stock targets (total):');
        for (const resourceType of stockKeys) {
            const amount = clampNumber(stockTargets[resourceType], 0, 0);
            lines.push(`${resourceType}: ${amount}`);
        }
    } else {
        lines.push('Stock targets (total): (none)');
    }

    return lines.join('\n');
}

const managerTerminal = {
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

    getStockTargets: function(roomName) {
        const cfg = ensureMarketConfig();
        const merged = getRoomConfig(cfg, roomName);
        return normalizeStockTargets(getStockTargetsFromConfig(merged));
    },

    getTerminalStockTargets: function(roomName) {
        return this.getStockTargets(roomName);
    },

    getTrackedResources: function(roomName) {
        const cfg = ensureMarketConfig();
        const merged = getRoomConfig(cfg, roomName);
        return getTrackedResources(merged);
    },

    explainRoom: function(roomName, options) {
        const opts = options && typeof options === 'object' ? options : {};
        const lines = [];
        if (!Game.market) {
            lines.push('Market not available.');
            return { lines, summary: 'Market not available.' };
        }
        const room = Game.rooms[roomName];
        if (!room) {
            const msg = `Unknown room: ${roomName}`;
            lines.push(msg);
            return { lines, summary: msg };
        }
        const base = ensureMarketConfig();
        const cfg = getRoomConfig(base, room.name);
        const status = getRunStatus(room, cfg);
        lines.push(`Market calc for ${room.name} @ ${Game.time}: run=${status.ok ? 'yes' : 'no'}`);
        if (!status.ok) lines.push(`Run blockers: ${status.reasons.join(', ')}`);
        if (!status.ok && !opts.force) {
            lines.push('Tip: market("calc", roomName, "force") to evaluate anyway.');
            return { lines, summary: `Skipped market calc for ${room.name}` };
        }

        if (!room.terminal) {
            lines.push('No terminal in room.');
            return { lines, summary: `No terminal in ${room.name}` };
        }

        const totals = getTerminalTotals(room);
        lines.push(`Totals: terminal resources=${Object.keys(totals).length}`);
        lines.push(`Credits=${Game.market.credits} minCredits=${cfg.minCredits} energyValue=${cfg.energyValue}`);
        const terminalEnergy = room.terminal.store[RESOURCE_ENERGY] || 0;
        const energySpendable = terminalEnergy - cfg.energyReserve;
        lines.push(
            `Terminal energy: current=${terminalEnergy} reserve=${cfg.energyReserve} ` +
            `spendable=${energySpendable} target=${cfg.terminalEnergyTarget} max=${cfg.terminalEnergyMax}`
        );

        buildBuyExplanation(room, cfg, totals).forEach(line => lines.push(line));
        buildSellExplanation(room, cfg, totals).forEach(line => lines.push(line));

        return { lines, summary: `Explained market for ${room.name}` };
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

        const totals = getTerminalTotals(room);

        if (tryBuy(room, cfg, totals)) return;
        trySell(room, cfg, totals);
    }
};

module.exports = managerTerminal;
