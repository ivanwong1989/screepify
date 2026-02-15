var userMissions = require('userMissions');
var shared = require('console_shared');

function normalizeEconomyOverride(mode) {
    const raw = mode ? ('' + mode).trim().toLowerCase() : '';
    if (!raw) return null;
    if (raw === 'upgrade' || raw === 'upgrading' || raw === 'u') return 'UPGRADING';
    if (raw === 'stockpile' || raw === 'stockpiling' || raw === 's') return 'STOCKPILING';
    if (raw === 'auto' || raw === 'clear' || raw === 'off' || raw === 'none') return null;
    return undefined;
}

function ensureEconomyRoomMemory(roomName) {
    const name = userMissions.normalizeRoomName(roomName);
    if (!name) return null;
    if (!Memory.rooms) Memory.rooms = {};
    const room = Game.rooms[name];
    const roomMemory = room ? room.memory : (Memory.rooms[name] = Memory.rooms[name] || {});
    if (!roomMemory.overseer) roomMemory.overseer = {};
    return roomMemory.overseer;
}

function showEconomyHelp() {
    const lines = [
        'economy()                         - show this help',
        'economy(\"status\")                  - show economy override status',
        'economy(\"room\", roomName, \"upgrade\") - force UPGRADING state for a room',
        'economy(\"room\", roomName, \"stockpile\") - force STOCKPILING state for a room',
        'economy(\"room\", roomName, \"auto\")    - clear override (auto state)'
    ];
    for (const line of lines) console.log(line);
    return 'Done';
}

module.exports = function registerEconomyConsole() {
    global.economy = function(action, ...args) {
        const cmd = action ? ('' + action).trim().toLowerCase() : 'help';
        if (!cmd || cmd === 'help' || cmd === 'h') return showEconomyHelp();

        if (cmd === 'status' || cmd === 's') {
            const lines = ['Economy overrides:'];
            const ownedRooms = shared.getOwnedSpawnRoomsForMissionCreate();
            if (!ownedRooms || ownedRooms.length === 0) {
                lines.push('Owned rooms: (none)');
            } else {
                ownedRooms.sort().forEach(roomName => {
                    const overseer = ensureEconomyRoomMemory(roomName);
                    const override = overseer && overseer.economyOverride;
                    const room = Game.rooms[roomName];
                    const live = room && room._economyState ? ` state=${room._economyState}` : '';
                    lines.push(`${roomName}: ${override || 'AUTO'}${live}`);
                });
            }
            lines.forEach(line => console.log(line));
            return lines[0];
        }

        if (cmd === 'room') {
            const roomName = userMissions.normalizeRoomName(args[0]);
            if (!roomName) return 'Usage: economy(\"room\", \"W1N1\", \"upgrade|stockpile|auto|status\")';
            const overseer = ensureEconomyRoomMemory(roomName);
            if (!overseer) return `Unknown room: ${roomName}`;
            const mode = args[1] ? ('' + args[1]).trim().toLowerCase() : 'status';
            if (mode === 'status' || mode === 's') {
                const override = overseer.economyOverride;
                const room = Game.rooms[roomName];
                const live = room && room._economyState ? ` state=${room._economyState}` : '';
                const msg = `Economy override for ${roomName}: ${override || 'AUTO'}${live}`;
                console.log(msg);
                return msg;
            }

            const normalized = normalizeEconomyOverride(mode);
            if (normalized === undefined) {
                return 'Usage: economy(\"room\", \"W1N1\", \"upgrade|stockpile|auto|status\")';
            }
            if (normalized === null) {
                delete overseer.economyOverride;
                const msg = `Economy override for ${roomName}: AUTO`;
                console.log(msg);
                return msg;
            }
            overseer.economyOverride = normalized;
            const msg = `Economy override for ${roomName}: ${normalized}`;
            console.log(msg);
            return msg;
        }

        return showEconomyHelp();
    };
};
