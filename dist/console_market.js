var managerMarket = require('managers_overseer_manager.room.economy.market');

function showMarketHelp() {
    const lines = [
        'market()                          - show this help',
        'market(\"status\")                   - show market auto-trade status',
        'market(\"on\") / market(\"off\")       - enable or disable auto-trading',
        'market(\"set\", { ... })             - patch global market settings',
        'market(\"room\", roomName, { ... })  - patch per-room overrides',
        'market(\"room\", roomName, \"on|off\") - enable/disable per-room trading',
        'market(\"room\", roomName, \"report\") - show mineral totals (ledger + terminal)',
        'market(\"calc\", roomName, \"force\"?) - show buy/sell calc details for a room',
        'example: market(\"set\", { stockTargets: { LO: 2000 }, buy: { LO: { maxPrice: 1.5 } } })',
        'example: market(\"set\", { stockTargets: { energy: 100000 }, sell: { energy: { minPrice: 0.01 } } })',
        'example: market(\"set\", { energyValue: 16, maxOverpayPct: 0.08, sellBufferPct: 0.05 })'
    ];
    for (const line of lines) console.log(line);
    return 'Done';
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
    const room = Game.rooms[roomName];
    if (!room) return `Unknown room: ${roomName}`;
    const ledger = room._resourceLedger || (room.memory.overseer && room.memory.overseer.resourceLedger);
    const totals = ledger && ledger.totals ? ledger.totals : collectRoomMineralTotals(room);
    const tracked = managerMarket.getTrackedResources(roomName);
    const stockTargets = managerMarket.getStockTargets(roomName);
    const lines = [];

    if (tracked.length > 0) {
        lines.push(`Tracked resources (${tracked.length}):`);
        tracked.sort().forEach(resourceType => {
            if (resourceType === RESOURCE_ENERGY) return;
            const total = totals[resourceType] || 0;
            const terminalAmount = room.terminal ? (room.terminal.store[resourceType] || 0) : 0;
            const target = stockTargets[resourceType] || 0;
            lines.push(`${resourceType}: total=${total} terminal=${terminalAmount} stockTarget=${target}`);
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

module.exports = function registerMarketConsole() {
    global.market = function(action, ...args) {
        const cmd = action ? ('' + action).trim().toLowerCase() : 'help';
        if (!cmd || cmd === 'help' || cmd === 'h') return showMarketHelp();

        if (cmd === 'status' || cmd === 's') {
            const msg = managerMarket.summarize();
            console.log(msg);
            return msg;
        }

        if (cmd === 'on' || cmd === 'enable') {
            managerMarket.applyPatch({ enabled: true });
            const msg = managerMarket.summarize();
            console.log(msg);
            return msg;
        }

        if (cmd === 'off' || cmd === 'disable') {
            managerMarket.applyPatch({ enabled: false });
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
            const roomName = args[0];
            if (!roomName) return 'Usage: market(\"room\", \"W1N1\", { ... })';
            const patch = args[1];
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

        if (cmd === 'calc' || cmd === 'explain' || cmd === 'debug') {
            const roomName = args[0];
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

        return showMarketHelp();
    };
};
