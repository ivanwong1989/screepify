function normalizeAllyName(name) {
    if (name === undefined || name === null) return '';
    return ('' + name).trim();
}

function ensureAllies() {
    if (!Array.isArray(Memory.allies)) Memory.allies = [];
    return Memory.allies;
}

module.exports = function registerAlliesConsole() {
    global.allyAdd = function(name) {
        const raw = normalizeAllyName(name);
        if (!raw) return 'Usage: allyAdd(\"PlayerName\")';
        const allies = ensureAllies();
        const exists = allies.some(a => ('' + a).toLowerCase() === raw.toLowerCase());
        if (!exists) allies.push(raw);
        return `Allies: ${JSON.stringify(allies)}`;
    };

    global.allyRemove = function(name) {
        const raw = normalizeAllyName(name);
        if (!raw) return 'Usage: allyRemove(\"PlayerName\")';
        const allies = ensureAllies();
        const filtered = allies.filter(a => ('' + a).toLowerCase() !== raw.toLowerCase());
        Memory.allies = filtered;
        return `Allies: ${JSON.stringify(Memory.allies)}`;
    };

    global.allyList = function() {
        const allies = ensureAllies();
        return `Allies: ${JSON.stringify(allies)}`;
    };
};
