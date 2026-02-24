var managerLabs = require('managers_structures_manager.labs');
var userMissions = require('userMissions');

function showLabHelp() {
    const lines = [
        'lab()                              - show this help',
        'lab("status")                       - show lab manager status',
        'lab("on") / lab("off")               - enable or disable lab manager',
        'lab("set", { ... })                 - patch global lab settings',
        'lab("room", roomName, { ... })      - patch per-room lab settings',
        'lab("room", roomName, "on|off")     - enable/disable per-room lab manager',
        'lab("clear", roomName)              - remove lab transfer missions for a room',
        'example: lab("set", { mode: "react", runEvery: 5 })',
        'example: lab("room", "W1N1", { reaction: { reagentA: "H", reagentB: "O" }, inputLabs: ["id1","id2"] })'
    ];
    for (const line of lines) console.log(line);
    return 'Done';
}

function clearLabMissions(roomName) {
    const key = ('' + roomName).trim();
    if (!key) return 'Usage: lab("clear", "W1N1")';
    const missions = userMissions.getByType('transfer');
    const prefix = `labmgr:${key}:`;
    let removed = 0;
    for (const mission of missions) {
        if (!mission || !mission.label) continue;
        if (mission.label.startsWith(prefix)) {
            if (userMissions.removeMission(mission.id)) removed += 1;
        }
    }
    return `Removed ${removed} lab transfer missions for ${key}`;
}

module.exports = function registerLabConsole() {
    global.lab = function(action, ...args) {
        const cmd = action ? ('' + action).trim().toLowerCase() : 'help';
        if (!cmd || cmd === 'help' || cmd === 'h') return showLabHelp();

        if (cmd === 'status' || cmd === 's') {
            const msg = managerLabs.summarize();
            console.log(msg);
            return msg;
        }

        if (cmd === 'on' || cmd === 'enable') {
            managerLabs.applyPatch({ enabled: true });
            const msg = managerLabs.summarize();
            console.log(msg);
            return msg;
        }

        if (cmd === 'off' || cmd === 'disable') {
            managerLabs.applyPatch({ enabled: false });
            const msg = managerLabs.summarize();
            console.log(msg);
            return msg;
        }

        if (cmd === 'set') {
            const patch = args[0];
            if (!patch || typeof patch !== 'object') return 'Usage: lab("set", { ... })';
            managerLabs.applyPatch(patch);
            const msg = managerLabs.summarize();
            console.log(msg);
            return msg;
        }

        if (cmd === 'room') {
            const roomName = args[0];
            if (!roomName) return 'Usage: lab("room", "W1N1", { ... })';
            const patch = args[1];
            if (patch === 'on' || patch === 'off') {
                managerLabs.applyRoomPatch(roomName, { enabled: patch === 'on' });
            } else if (patch && typeof patch === 'object') {
                managerLabs.applyRoomPatch(roomName, patch);
            }
            const msg = managerLabs.summarizeRoom(roomName);
            console.log(msg);
            return msg;
        }

        if (cmd === 'clear') {
            const roomName = args[0];
            const msg = clearLabMissions(roomName);
            console.log(msg);
            return msg;
        }

        return showLabHelp();
    };
};
