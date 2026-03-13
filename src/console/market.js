var managerMarket = require('managers_structures_manager.terminal');

function showMarketHelp() {
    const lines = [
        'market()                            - show this help',
        'market("status")                     - show global + room enablement',
        'market("status", roomName)           - show market config for a room',
        'market("on") / market("off")         - master switch only (globalEnabled)',
        'market("all", "on|off")              - set ALL rooms on/off (does not change globalEnabled)',
        'market("set", { ... })               - apply patch to ALL EXISTING rooms (no global params stored)',
        'market("room", roomName, { ... })    - patch per-room settings',
        'market("reset", roomName)           - reset a room back to safe defaults',
        'market("resetAll")                  - reset ALL rooms back to safe defaults',
        'market("room", roomName, "status")   - show market settings for a room',
        'market("room", roomName, "on|off")   - enable/disable a room',
        'market("room", roomName, "report")   - show mineral totals (ledger + terminal)',
        'market("calc", roomName, "force"?)   - show buy/sell calc details for a room',
        'market("order", "buy", room, resource, price, amount, "tag"?)  - create & track a BUY order',
        'market("order", "sell", room, resource, price, amount, "tag"?) - create & track a SELL order',
        'market("orders")                     - list tracked manual orders',
        'market("order", "cancel", orderId)   - cancel an order (and mark inactive)',
        'market("order", "untrack", orderId)  - stop tracking (does not cancel)',
        'market("send", from, to, resource, amount, "desc"?) - terminal send between rooms',
        'example: market("set", { runEvery: 25, energyReserve: 20000 })',
        'example: market("room", "W1N1", { terminalStockTargets: { LO: 2000 }, roomStockTargets: { LO: 8000 }, buy: { LO: { maxPrice: 1.5 } } })',
        'example: market("send", "W1N1", "W2N1", RESOURCE_ENERGY, 5000, "supply")',
        ''
    ];
    for (const line of lines) console.log(line);
    return 'Done';
}

function normalizeRoomName(roomName) {
    if (!roomName) return roomName;
    return ('' + roomName).trim().toUpperCase();
}

function collectRoomMineralTotals(room) {
    const totals = {};
    const addStore = (store) => {
        if (!store) return;
        for (const resourceType in store) {
            const amount = store[resourceType];
            if (amount > 0) totals[resourceType] = (totals[resourceType] || 0) + amount;
        }
    };
    addStore(room.storage && room.storage.store);
    addStore(room.terminal && room.terminal.store);
    return totals;
}

function marketReport(roomName) {
    roomName = normalizeRoomName(roomName);
    const room = Game.rooms[roomName];
    if (!room) return `Unknown room: ${roomName}`;
    const ledger = room._resourceLedger || (room.memory.overseer && room.memory.overseer.resourceLedger);
    const totals = ledger && ledger.totals ? ledger.totals : collectRoomMineralTotals(room);
    const tracked = managerMarket.getTrackedResources(roomName);
    const terminalStockTargets = managerMarket.getTerminalStockTargets(roomName);
    const roomStockTargets = managerMarket.getRoomStockTargets(roomName);
    const lines = [];

    if (tracked.length > 0) {
        lines.push(`Tracked resources (${tracked.length}):`);
        tracked.sort().forEach(resourceType => {
            if (resourceType === RESOURCE_ENERGY) return;
            const total = totals[resourceType] || 0;
            const terminalAmount = room.terminal ? (room.terminal.store[resourceType] || 0) : 0;
            const terminalTarget = terminalStockTargets[resourceType] || 0;
            const roomTarget = roomStockTargets[resourceType] || 0;
            lines.push(`${resourceType}: total=${total} terminal=${terminalAmount} terminalTarget=${terminalTarget} roomTarget=${roomTarget}`);
        });
    }

    const mineralKeys = Object.keys(totals).filter(r => r !== RESOURCE_ENERGY).sort();
    if (mineralKeys.length > 0) {
        lines.push('All minerals (ledger totals):');
        mineralKeys.forEach(resourceType => {
            lines.push(`${resourceType}: ${totals[resourceType] || 0}`);
        });
    } else {
        lines.push('No minerals recorded in ledger.');
    }

    lines.forEach(line => console.log(line));
    return `Reported minerals for ${roomName}`;
}


function toNumber(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : NaN;
}

function findNewOrderId(beforeIds, afterIds) {
    const before = new Set(beforeIds || []);
    const created = (afterIds || []).filter(id => !before.has(id));
    if (created.length === 1) return created[0];
    return null;
}

function printManualOrders() {
    const items = managerMarket.listManualOrders();
    if (!items || items.length === 0) {
        console.log('No tracked manual orders.');
        return 'No tracked manual orders.';
    }
    console.log(`Tracked manual orders: ${items.length}`);
    for (const rec of items.slice(0, 50)) {
        const active = rec.active ? 'active' : 'inactive';
        console.log(
            `${rec.id} ${active} type=${rec.type} resource=${rec.resourceType} room=${rec.roomName} ` +
            `price=${rec.price} total=${rec.totalAmount} tag=${rec.tag || ''}`
        );
    }
    if (items.length > 50) console.log(`(+${items.length - 50} more)`);
    return `Listed ${items.length} manual orders`;
}

function createAndTrackOrder(kind, roomName, resourceType, price, amount, tag) {
    if (!Game.market) return 'Market not available.';
    roomName = normalizeRoomName(roomName);
    const room = Game.rooms[roomName];
    if (!room) return `Unknown room: ${roomName}`;
    if (!room.controller || !room.controller.my) return `Room not owned: ${roomName}`;
    if (!room.terminal) return `No terminal in room: ${roomName}`;

    const type = ('' + kind).toLowerCase() === 'sell' ? ORDER_SELL : ORDER_BUY;
    const p = toNumber(price);
    const a = Math.floor(toNumber(amount));
    if (!resourceType) return 'Usage: market("order", "buy|sell", room, resource, price, amount, "tag"?)';
    if (!Number.isFinite(p) || p <= 0) return `Invalid price: ${price}`;
    if (!Number.isFinite(a) || a <= 0) return `Invalid amount: ${amount}`;

    if (type === ORDER_SELL) {
        const have = room.terminal.store[resourceType] || 0;
        if (have <= 0) console.log(`[Market] Warning: terminal has 0 ${resourceType} (sell order can exist, but deals will fail without stock)`);
    }

    const beforeIds = Object.keys(Game.market.orders || {});
    const res = Game.market.createOrder({
        type,
        resourceType,
        price: p,
        totalAmount: a,
        roomName
    });
    if (res !== OK) return `createOrder failed: ${res}`;

    const afterIds = Object.keys(Game.market.orders || {});
    let newId = findNewOrderId(beforeIds, afterIds);

    // Fallback: try to find a matching order (rarely needed)
    if (!newId) {
        for (const id of afterIds) {
            if (beforeIds.includes(id)) continue;
            const o = Game.market.orders[id];
            if (!o) continue;
            if (o.type === type && o.resourceType === resourceType && o.roomName === roomName && o.price === p) {
                newId = id;
                break;
            }
        }
    }

    if (!newId) {
        console.log('[Market] Order created but could not reliably detect new order id; not tracking.');
        return 'Order created but could not detect id (not tracked).';
    }

    managerMarket.trackManualOrder(newId, {
        type,
        resourceType,
        roomName,
        price: p,
        totalAmount: a,
        tag: tag || '',
        created: Game.time
    });

    console.log(`[Market] Created & tracked order id=${newId} type=${type} ${resourceType} price=${p} total=${a} room=${roomName} tag=${tag || ''}`);
    return `Created order ${newId}`;
}


module.exports = function registerMarketConsole() {
    global.market = function(action, ...args) {
        const cmd = action ? ('' + action).trim().toLowerCase() : 'help';
        if (!cmd || cmd === 'help' || cmd === 'h') return showMarketHelp();

        if (cmd === 'status' || cmd === 's') {
            const roomName = normalizeRoomName(args[0]);
            const msg = roomName ? managerMarket.summarizeRoom(roomName) : managerMarket.summarize();
            console.log(msg);
            return msg;
        }

        if (cmd === 'on' || cmd === 'enable') {
            const cfg = managerMarket.getConfig();
            cfg.globalEnabled = true;
            const msg = managerMarket.summarize();
            console.log(msg);
            return msg;
        }

        if (cmd === 'off' || cmd === 'disable') {
            const cfg = managerMarket.getConfig();
            cfg.globalEnabled = false;
            const msg = managerMarket.summarize();
            console.log(msg);
            return msg;
        }

        if (cmd === 'all') {
            const mode = args[0] ? ('' + args[0]).trim().toLowerCase() : '';
            if (mode !== 'on' && mode !== 'off') return 'Usage: market("all", "on|off")';
            const current = managerMarket.getConfig();
            managerMarket.applyPatch({ globalEnabled: current && current.globalEnabled !== false, enabled: mode === 'on' });
            const msg = managerMarket.summarize();
            console.log(msg);
            return msg;
        }


        if (cmd === 'set') {
            const patch = args[0];
            if (!patch || typeof patch !== 'object') return 'Usage: market(\"set\", { ... })';
            managerMarket.applyPatch(patch);
            const msg = managerMarket.summarize();
            console.log(msg);
            return msg;
        }

        if (cmd === 'room') {
            const roomName = normalizeRoomName(args[0]);
            if (!roomName) return 'Usage: market(\"room\", \"W1N1\", { ... })';
            const patch = args[1];
            if (patch === 'status' || patch === 's') {
                const msg = managerMarket.summarizeRoom(roomName);
                console.log(msg);
                return msg;
            }
            if (patch === 'report' || patch === 'ledger') {
                return marketReport(roomName);
            }
            if (patch === 'on' || patch === 'off') {
                managerMarket.applyRoomPatch(roomName, { enabled: patch === 'on' });
            } else if (patch && typeof patch === 'object') {
                managerMarket.applyRoomPatch(roomName, patch);
            }
            const msg = managerMarket.summarizeRoom(roomName);
            console.log(msg);
            return msg;
        }

        if (cmd === 'reset') {
            const roomName = normalizeRoomName(args[0]);
            if (!roomName) return 'Usage: market("reset", "W1N1")';
            managerMarket.resetRoom(roomName);
            const msg = managerMarket.summarizeRoom(roomName);
            console.log(msg);
            return msg;
        }

        if (cmd === 'resetAll') {
            const cfg = managerMarket.getConfig();
            const rooms = Object.keys((cfg && cfg.rooms) || {});
            for (const rn of rooms) managerMarket.resetRoom(rn);
            const msg = managerMarket.summarize();
            console.log(msg);
            return msg;
        }

        if (cmd === 'calc' || cmd === 'explain' || cmd === 'debug') {
            const roomName = normalizeRoomName(args[0]);
            if (!roomName) return 'Usage: market(\"calc\", \"W1N1\", \"force\"?)';
            const mode = args[1];
            const opts = {};
            if (mode === 'force' || mode === 'f') opts.force = true;
            const result = managerMarket.explainRoom(roomName, opts);
            if (result && Array.isArray(result.lines)) {
                result.lines.forEach(line => console.log(line));
            }
            return result && result.summary ? result.summary : 'Done';
        }


        if (cmd === 'orders' || cmd === 'manualorders' || cmd === 'o') {
            return printManualOrders();
        }

        if (cmd === 'send' || cmd === 'xfer' || cmd === 'transfer') {
            const fromRoomName = normalizeRoomName(args[0]);
            const toRoomName = normalizeRoomName(args[1]);
            const resourceType = args[2];
            const amount = args[3];
            const description = args[4];
            if (!fromRoomName || !toRoomName || !resourceType || amount === undefined) {
                return 'Usage: market("send", fromRoom, toRoom, resourceType, amount, "description"?)';
            }

            const outcome = managerMarket.sendResource(fromRoomName, toRoomName, resourceType, amount, description);
            const msg = outcome && outcome.ok
                ? `Sent ${outcome.amount} ${outcome.resourceType} ${outcome.fromRoomName}->${outcome.toRoomName} energyCost=${outcome.energyCost}`
                : `Send failed: ${(outcome && outcome.error) || 'unknown'}`;
            console.log(msg);
            return msg;
        }

        if (cmd === 'order') {
            const sub = args[0] ? ('' + args[0]).trim().toLowerCase() : '';

            if (sub === 'buy' || sub === 'sell') {
                const roomName = normalizeRoomName(args[1]);
                const resourceType = args[2];
                const price = args[3];
                const amount = args[4];
                const tag = args[5];
                return createAndTrackOrder(sub, roomName, resourceType, price, amount, tag);
            }

            if (sub === 'cancel') {
                const id = args[1];
                if (!id) return 'Usage: market("order", "cancel", orderId)';
                const r = managerMarket.cancelManualOrder(id);
                const msg = r && r.ok ? `Canceled order ${r.id}` : `Cancel failed: ${r.error || 'unknown'}`;
                console.log(msg);
                return msg;
            }

            if (sub === 'untrack' || sub === 'rm' || sub === 'remove') {
                const id = args[1];
                if (!id) return 'Usage: market("order", "untrack", orderId)';
                const r = managerMarket.untrackManualOrder(id);
                const msg = r && r.ok ? `Untracked order ${r.id}` : `Untrack failed: ${r.error || 'unknown'}`;
                console.log(msg);
                return msg;
            }
            
            return showMarketHelp();
        }
        return showMarketHelp();
    };
};
