var managerLabs = require('managers_structures_manager.labs');
var userMissions = require('userMissions');

function showLabHelp() {
    const lines = [
        'lab()                                  - show this help',
        'lab("status")                           - show lab manager status',
        'lab("on") / lab("off")                  - enable or disable lab manager',
        'lab("set", { ... })                     - patch global lab settings',
        'lab("room", roomName, { ... })          - patch per-room lab settings',
        'lab("room", roomName, "on|off")         - enable/disable per-room lab manager',
        'lab("clear", roomName)                  - remove lab transfer missions for a room',
        'lab("stop")                             - set mode="idle" (stop reactions)',
        'lab("idle")                             - set mode="idle" (no reactions; optional cleanupIdle can clear labs)',
        'lab("purge")                            - set mode="purge" (clear minerals from all labs back to storage/terminal)',
        'lab("roomIdle", roomName)                - set per-room mode="idle"',
        'lab("roomPurge", roomName)               - set per-room mode="purge"',

        '',
        'Forward react shortcuts:',
        'lab("react", reagentA, reagentB, opts?)             - set global mode=react + reaction',
        'lab("roomReact", roomName, reagentA, reagentB, opts?) - set per-room mode=react + reaction',

        '',
        'Reverse shortcuts:',
        'lab("reverse", product, opts?)                      - set global mode=reverse + product',
        'lab("roomReverse", roomName, product, opts?)        - set per-room mode=reverse + product',

        '',
        'Boost shortcuts:',
        'lab("boost", { XGH2O:"labId" })                 - global boost mode',
        'lab("roomBoost", "W1N1", { XGH2O:"labId" })     - per-room boost mode',

        '',
        'Examples:',
        'lab("react", "H", "O", { inputLabs:["id1","id2"], inputTarget:2000 })',
        'lab("roomReact", "W1N1", "ZK", "UL", { inputLabs:["id1","id2"] })',
        'lab("reverse", "GH2O", { productTarget:2000, maxReactionsPerTick:3 })',
        'lab("roomReverse", "W1N1", "XGH2O", { productTarget:5000 })'
    ];
    for (const line of lines) console.log(line);
    return 'Done';
}

function clearLabMissions(roomName) {
    const key = ('' + roomName).trim();
    if (!key) return 'Usage: lab("clear", "W1N1")';

    const missions = userMissions.getByType('transfer');
    const prefix = `labhaul:${key}:`; // matches manager.labs.js mission naming

    let removed = 0;
    for (const mission of missions) {
        if (!mission) continue;

        // lab manager publishes "name" (stable id); support "label" too just in case
        const name = mission.name || mission.label;
        if (!name || typeof name !== 'string') continue;

        if (name.startsWith(prefix)) {
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

        if (cmd === 'stop') {
            managerLabs.applyPatch({ mode: 'idle' });
            const msg = managerLabs.summarize();
            console.log(msg);
            return msg;
        }

        if (cmd === 'idle') {
            managerLabs.applyPatch({ mode: 'idle' });
            const msg = managerLabs.summarize();
            console.log(msg);
            return msg;
        }

        if (cmd === 'purge') {
            managerLabs.applyPatch({ mode: 'purge' });
            const msg = managerLabs.summarize();
            console.log(msg);
            return msg;
        }

        if (cmd === 'roomidle') {
            const roomName = args[0];
            if (!roomName) return 'Usage: lab("roomIdle", "W1N1")';
            managerLabs.applyRoomPatch(roomName, { mode: 'idle' });
            const msg = managerLabs.summarizeRoom(roomName);
            console.log(msg);
            return msg;
        }

        if (cmd === 'roompurge') {
            const roomName = args[0];
            if (!roomName) return 'Usage: lab("roomPurge", "W1N1")';
            managerLabs.applyRoomPatch(roomName, { mode: 'purge' });
            const msg = managerLabs.summarizeRoom(roomName);
            console.log(msg);
            return msg;
        }

        if (cmd === 'react') {
            const reagentA = args[0];
            const reagentB = args[1];
            const opts = args[2];

            if (!reagentA || !reagentB)
                return 'Usage: lab("react", "H", "O", { inputLabs: [...], outputLabs: [...] })';

            const patch = Object.assign({
                mode: 'react',
                reaction: {
                    reagentA,
                    reagentB
                }
            }, (opts && typeof opts === 'object') ? opts : {});

            managerLabs.applyPatch(patch);
            const msg = managerLabs.summarize();
            console.log(msg);
            return msg;
        }

        if (cmd === 'roomreact') {
            const roomName = args[0];
            const reagentA = args[1];
            const reagentB = args[2];
            const opts = args[3];

            if (!roomName || !reagentA || !reagentB)
                return 'Usage: lab("roomReact", "W1N1", "H", "O", { inputLabs: [...] })';

            const patch = Object.assign({
                mode: 'react',
                reaction: {
                    reagentA,
                    reagentB
                }
            }, (opts && typeof opts === 'object') ? opts : {});

            managerLabs.applyRoomPatch(roomName, patch);
            const msg = managerLabs.summarizeRoom(roomName);
            console.log(msg);
            return msg;
        }

        if (cmd === 'reverse') {
            const product = args[0];
            const opts = args[1];

            if (!product) return 'Usage: lab("reverse", "GH2O", { productTarget: 2000 })';

            const patch = {
                mode: 'reverse',
                reverse: Object.assign({ product: product }, (opts && typeof opts === 'object') ? opts : {})
            };

            managerLabs.applyPatch(patch);
            const msg = managerLabs.summarize();
            console.log(msg);
            return msg;
        }

        if (cmd === 'roomreverse') {
            const roomName = args[0];
            const product = args[1];
            const opts = args[2];

            if (!roomName || !product) return 'Usage: lab("roomReverse", "W1N1", "GH2O", { productTarget: 2000 })';

            const patch = {
                mode: 'reverse',
                reverse: Object.assign({ product: product }, (opts && typeof opts === 'object') ? opts : {})
            };

            managerLabs.applyRoomPatch(roomName, patch);
            const msg = managerLabs.summarizeRoom(roomName);
            console.log(msg);
            return msg;
        }

        if (cmd === 'boost') {
            const boostMap = args[0];
            const opts = args[1];

            if (!boostMap || typeof boostMap !== 'object')
                return 'Usage: lab("boost", { XGH2O: "labId1" }, { boostTarget: 2000 })';

            const patch = Object.assign({
                mode: 'boost',
                boosts: boostMap
            }, (opts && typeof opts === 'object') ? opts : {});

            managerLabs.applyPatch(patch);
            const msg = managerLabs.summarize();
            console.log(msg);
            return msg;
        }

        if (cmd === 'roomboost') {
            const roomName = args[0];
            const boostMap = args[1];
            const opts = args[2];

            if (!roomName || !boostMap || typeof boostMap !== 'object')
                return 'Usage: lab("roomBoost", "W1N1", { XGH2O: "labId1" })';

            const patch = Object.assign({
                mode: 'boost',
                boosts: boostMap
            }, (opts && typeof opts === 'object') ? opts : {});

            managerLabs.applyRoomPatch(roomName, patch);
            const msg = managerLabs.summarizeRoom(roomName);
            console.log(msg);
            return msg;
        }

        return showLabHelp();
    };
};
