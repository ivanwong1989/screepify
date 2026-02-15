var userMissions = require('userMissions');
var shared = require('console_shared');

function getGlobalRemoteEnabled() {
    if (Memory.remoteMissionsEnabled === undefined) Memory.remoteMissionsEnabled = true;
    return Memory.remoteMissionsEnabled !== false;
}

function setGlobalRemoteEnabled(enabled) {
    Memory.remoteMissionsEnabled = enabled === true;
    return Memory.remoteMissionsEnabled;
}

function ensureRemoteRoomMemory(roomName) {
    const name = userMissions.normalizeRoomName(roomName);
    if (!name) return null;
    if (!Memory.rooms) Memory.rooms = {};
    const room = Game.rooms[name];
    const roomMemory = room ? room.memory : (Memory.rooms[name] = Memory.rooms[name] || {});
    if (!roomMemory.overseer) roomMemory.overseer = {};
    if (!roomMemory.overseer.remote) roomMemory.overseer.remote = { rooms: {} };
    if (!roomMemory.overseer.remote.rooms) roomMemory.overseer.remote.rooms = {};
    if (!Array.isArray(roomMemory.overseer.remote.skipRooms)) roomMemory.overseer.remote.skipRooms = [];
    if (roomMemory.overseer.remote.enabled === undefined) roomMemory.overseer.remote.enabled = true;
    return roomMemory.overseer.remote;
}

function showRemoteHelp() {
    const lines = [
        'remote()                          - show this help',
        'remote(\"status\")                   - show remote mission status',
        'remote(\"on\") / remote(\"off\")       - enable or disable remote missions globally',
        'remote(\"room\", roomName, \"on|off\")  - enable/disable remote missions for a room',
        'remote(\"room\", roomName, \"status\")  - show remote mission status for a room'
    ];
    for (const line of lines) console.log(line);
    return 'Done';
}

module.exports = function registerRemoteConsole() {
    global.remote = function(action, ...args) {
        const cmd = action ? ('' + action).trim().toLowerCase() : 'help';
        if (!cmd || cmd === 'help' || cmd === 'h') return showRemoteHelp();

        if (cmd === 'status' || cmd === 's') {
            const globalEnabled = getGlobalRemoteEnabled();
            const lines = [`Remote missions: ${globalEnabled ? 'ON' : 'OFF'}`];
            const ownedRooms = shared.getOwnedSpawnRoomsForMissionCreate();
            if (!ownedRooms || ownedRooms.length === 0) {
                lines.push('Owned rooms: (none)');
            } else {
                ownedRooms.sort().forEach(roomName => {
                    const remote = ensureRemoteRoomMemory(roomName);
                    const enabled = remote ? remote.enabled !== false : true;
                    lines.push(`${roomName}: ${enabled ? 'on' : 'off'}`);
                });
            }
            lines.forEach(line => console.log(line));
            return lines[0];
        }

        if (cmd === 'on' || cmd === 'enable') {
            setGlobalRemoteEnabled(true);
            const msg = 'Remote missions: ON (global)';
            console.log(msg);
            return msg;
        }

        if (cmd === 'off' || cmd === 'disable') {
            setGlobalRemoteEnabled(false);
            const msg = 'Remote missions: OFF (global)';
            console.log(msg);
            return msg;
        }

        if (cmd === 'room') {
            const roomName = userMissions.normalizeRoomName(args[0]);
            if (!roomName) return 'Usage: remote(\"room\", \"W1N1\", \"on|off|status\")';
            const remote = ensureRemoteRoomMemory(roomName);
            if (!remote) return `Unknown room: ${roomName}`;

            const mode = args[1] ? ('' + args[1]).trim().toLowerCase() : 'status';
            if (mode === 'on' || mode === 'enable') {
                remote.enabled = true;
                const msg = `Remote missions for ${roomName}: ON`;
                console.log(msg);
                return msg;
            }
            if (mode === 'off' || mode === 'disable') {
                remote.enabled = false;
                const msg = `Remote missions for ${roomName}: OFF`;
                console.log(msg);
                return msg;
            }
            if (mode === 'status' || mode === 's') {
                const msg = `Remote missions for ${roomName}: ${remote.enabled !== false ? 'ON' : 'OFF'}`;
                console.log(msg);
                return msg;
            }

            return 'Usage: remote(\"room\", \"W1N1\", \"on|off|status\")';
        }

        return showRemoteHelp();
    };
};
