var userMissions = require('userMissions');
var shared = require('console_shared');

function showEconomyHelp() {
    const lines = [
        'economy()                         - show this help',
        'economy("status")                  - show room states',
        'economy("room", roomName, "status") - show room state'
    ];
    for (const line of lines) console.log(line);
    return 'Done';
}

module.exports = function registerEconomyConsole() {
    global.economy = function(action, ...args) {
        const cmd = action ? ('' + action).trim().toLowerCase() : 'help';
        if (!cmd || cmd === 'help' || cmd === 'h') return showEconomyHelp();

        if (cmd === 'status' || cmd === 's') {
            const lines = ['Room states:'];
            const ownedRooms = shared.getOwnedSpawnRoomsForMissionCreate();
            if (!ownedRooms || ownedRooms.length === 0) {
                lines.push('Owned rooms: (none)');
            } else {
                ownedRooms.sort().forEach(roomName => {
                    const room = Game.rooms[roomName];
                    const live = room && room._policy && room._policy.state ? ` state=${room._policy.state}` : ' state=UNKNOWN';
                    lines.push(`${roomName}:${live}`);
                });
            }
            lines.forEach(line => console.log(line));
            return lines[0];
        }

        if (cmd === 'room') {
            const roomName = userMissions.normalizeRoomName(args[0]);
            if (!roomName) return 'Usage: economy("room", "W1N1", "status")';
            const mode = args[1] ? ('' + args[1]).trim().toLowerCase() : 'status';
            if (mode !== 'status' && mode !== 's') {
                return 'Economy overrides were removed. Use economy("room", roomName, "status").';
            }
            const room = Game.rooms[roomName];
            const live = room && room._policy && room._policy.state ? ` state=${room._policy.state}` : ' state=UNKNOWN';
            const msg = `Room state for ${roomName}:${live}`;
            console.log(msg);
            return msg;
        }

        return showEconomyHelp();
    };
};
