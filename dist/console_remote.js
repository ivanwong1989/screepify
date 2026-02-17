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
        'remote(\"econ\", ...)                - alias for remote() (auto-econ only)',
        'remote(\"status\")                   - show remote mission status',
        'remote(\"on\") / remote(\"off\")       - enable or disable remote missions globally',
        'remote(\"room\", roomName, \"on|off\")  - enable/disable remote missions for a room',
        'remote(\"room\", roomName, \"status\")  - show remote mission status for a room',
        'remote(\"skip\", targetRoom)           - skip remote econ rooms (auto sponsor)',
        'remote(\"skip\", sponsorRoom, targetRoom) - skip remote econ rooms for a sponsor',
        'remote(\"unskip\", targetRoom)         - unskip remote econ rooms (auto sponsor)',
        'remote(\"unskip\", sponsorRoom, targetRoom) - unskip remote econ rooms for a sponsor',
        'remote(\"skip\", \"list\")             - list skipped rooms for all sponsors',
        'remote(\"skip\", sponsorRoom, \"list\") - list skipped rooms for a sponsor',
        'Note: remote() affects auto-econ remotes (harvest/haul/build/repair).',
        'Claim/reserve are user missions and are not affected.'
    ];
    for (const line of lines) console.log(line);
    return 'Done';
}

function listSkipRooms(roomName) {
    const ownedRooms = shared.getOwnedSpawnRoomsForMissionCreate();
    const listRooms = roomName ? [roomName] : ownedRooms;
    if (!listRooms || listRooms.length === 0) {
        const msg = roomName ? `Unknown room: ${roomName}` : 'Owned rooms: (none)';
        console.log(msg);
        return msg;
    }
    const lines = [];
    listRooms.sort().forEach(name => {
        const remote = ensureRemoteRoomMemory(name);
        const skipped = (remote && Array.isArray(remote.skipRooms)) ? remote.skipRooms.slice().sort() : [];
        lines.push(`${name} skipRooms: ${skipped.length > 0 ? skipped.join(', ') : '(none)'}`);
    });
    lines.forEach(line => console.log(line));
    return lines[0] || 'Done';
}

function resolveSkipArgs(args) {
    const first = userMissions.normalizeRoomName(args[0]);
    const second = userMissions.normalizeRoomName(args[1]);
    if (first && (first.toLowerCase() === 'list' || first.toLowerCase() === 'ls' || first.toLowerCase() === 'status')) {
        return { mode: 'list' };
    }
    if (second && (second.toLowerCase() === 'list' || second.toLowerCase() === 'ls' || second.toLowerCase() === 'status')) {
        return { mode: 'list', sponsorRoom: first };
    }

    if (!second) {
        const targetRoom = first;
        if (!targetRoom) return null;
        const sponsorRoom = shared.resolveSponsorRoomForTargetRoom(targetRoom);
        return sponsorRoom ? { sponsorRoom, targetRoom } : { sponsorRoom: null, targetRoom };
    }

    return { sponsorRoom: first, targetRoom: second };
}

function addSkipRoom(remote, roomName) {
    if (!remote || !roomName) return false;
    if (!Array.isArray(remote.skipRooms)) remote.skipRooms = [];
    if (!remote.skipRooms.includes(roomName)) remote.skipRooms.push(roomName);
    if (remote.rooms && remote.rooms[roomName]) delete remote.rooms[roomName];
    return true;
}

function removeSkipRoom(remote, roomName) {
    if (!remote || !roomName || !Array.isArray(remote.skipRooms)) return false;
    const before = remote.skipRooms.length;
    remote.skipRooms = remote.skipRooms.filter(name => name !== roomName);
    return remote.skipRooms.length !== before;
}

module.exports = function registerRemoteConsole() {
    global.remote = function(action, ...args) {
        let cmd = action ? ('' + action).trim().toLowerCase() : 'help';
        if (cmd === 'econ' || cmd === 'auto') {
            if (args.length === 0) return showRemoteHelp();
            cmd = ('' + args[0]).trim().toLowerCase();
            args = args.slice(1);
        }
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

        if (cmd === 'skip' || cmd === 'unskip') {
            const skipArgs = resolveSkipArgs(args);
            if (!skipArgs) return 'Usage: remote(\"skip\", targetRoom) OR remote(\"skip\", sponsorRoom, targetRoom) OR remote(\"skip\", \"list\")';
            if (skipArgs.mode === 'list') {
                return listSkipRooms(skipArgs.sponsorRoom || null);
            }

            const sponsorRoom = skipArgs.sponsorRoom;
            const targetRoom = skipArgs.targetRoom;
            if (!targetRoom) return 'Usage: remote(\"skip\", targetRoom) OR remote(\"skip\", sponsorRoom, targetRoom)';
            if (!sponsorRoom) return `Unable to resolve sponsor room for ${targetRoom}`;

            const remote = ensureRemoteRoomMemory(sponsorRoom);
            if (!remote) return `Unknown room: ${sponsorRoom}`;

            if (cmd === 'skip') {
                addSkipRoom(remote, targetRoom);
                const msg = `Skip remote econ for ${targetRoom} (sponsor ${sponsorRoom})`;
                console.log(msg);
                return msg;
            }

            removeSkipRoom(remote, targetRoom);
            const msg = `Unskip remote econ for ${targetRoom} (sponsor ${sponsorRoom})`;
            console.log(msg);
            return msg;
        }

        return showRemoteHelp();
    };
};
