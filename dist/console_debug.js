const DEBUG_CATEGORIES = Object.freeze([
    'admiral',
    'general',
    'mission.build',
    'mission.user.drainer',
    'mission.dismantle.flag',
    'mission.harvest',
    'mission.logistics',
    'mission.mineral',
    'mission.remote.harvest',
    'mission.remote.haul',
    'mission.repair',
    'mission.scout',
    'mission.tower',
    'mission.upgrade',
    'market',
    'overseer',
    'overseer.ledger',
    'overseer.policy',
    'roomCache',
    'spawner',
    'system'
]);

function registerDebugCategory(category) {
    if (!global._debugCategorySet) global._debugCategorySet = new Set();
    global._debugCategorySet.add(category);
}

function getAvailableDebugCategories() {
    const list = new Set(DEBUG_CATEGORIES);
    const cats = Memory.debugCategories;
    if (cats && typeof cats === 'object') {
        for (const key of Object.keys(cats)) list.add(key);
    }
    if (global._debugCategorySet instanceof Set) {
        for (const key of global._debugCategorySet) list.add(key);
    }
    return Array.from(list).sort();
}

function ensureDebugCategories() {
    if (!Memory.debugCategories || typeof Memory.debugCategories !== 'object') {
        Memory.debugCategories = {};
    }
    return Memory.debugCategories;
}

module.exports = function registerDebugConsole() {
    // Debug logger with optional category filtering.
    // If Memory.debugCategories has keys, only those categories will log.
    global.debug = function(category, ...args) {
        registerDebugCategory(category);
        if (!Memory.debug) return;
        const cats = Memory.debugCategories;
        if (cats && typeof cats === 'object') {
            if (!cats[category]) return;
        }
        console.log(...args);
    };

    // Backward-compatible logger (general category)
    global.log = function(...args) {
        global.debug('general', ...args);
    };

    // Combat logger
    global.logCombat = function(...args) {
        if (Memory.debugCombat) {
            console.log(...args);
        }
    };

    // Global debug command object
    Object.defineProperty(global, 'debugon', {
        get: function() {
            Memory.debug = true;
            Memory.debugMissions = true;
            console.log('Debug mode ENABLED');
            return 'Debug mode ENABLED';
        },
        configurable: true
    });

    Object.defineProperty(global, 'debugoff', {
        get: function() {
            delete Memory.debug;
            delete Memory.debugMissions;
            delete Memory.debugCategories;
            console.log('Debug mode DISABLED');
            return 'Debug mode DISABLED';
        },
        configurable: true
    });
 
    // Global debug command object
    Object.defineProperty(global, 'debugvison', {
        get: function() {
            Memory.debugVisual = true;
            console.log('Debug visual mode ENABLED');
            return 'Debug visual mode ENABLED';
        },
        configurable: true
    });

    Object.defineProperty(global, 'debugvisoff', {
        get: function() {
            delete Memory.debugVisual;
            console.log('Debug visual mode DISABLED');
            return 'Debug visual mode DISABLED';
        },
        configurable: true
    });

    Object.defineProperty(global, 'sparkstatson', {
        get: function() {
            Memory.telemetry.sparkStatsPrint = true;
            Memory.telemetry.enabled = true;
            console.log('Sparkline stats printing ENABLED');
            return 'Sparkline stats printing ENABLED';
        },
        configurable: true
    });

    Object.defineProperty(global, 'sparkstatsoff', {
        get: function() {
            Memory.telemetry.sparkStatsPrint = false;
            Memory.telemetry.enabled = false;
            console.log('Sparkline stats printing DISABLED');
            return 'Sparkline stats printing DISABLED';
        },
        configurable: true
    });

    Object.defineProperty(global, 'debugviscombaton', {
        get: function () {
            if (!Memory.visuals) Memory.visuals = {};

            Memory.visuals.combatMatrix = true;
            Memory.visuals.combatStep = 1;
            Memory.visuals.combatMinCost = 20;
            Memory.visuals.combatNumbers = true;
            Memory.visuals.combatNumberThreshold = 40;

            console.log('Debug visuals combat mode ENABLED');
            return 'Debug visuals combat mode ENABLED';
        },
        configurable: true
    });

    Object.defineProperty(global, 'debugviscombatoff', {
        get: function () {
            if (Memory.visuals) {
                delete Memory.visuals.combatMatrix;
                delete Memory.visuals.combatStep;
                delete Memory.visuals.combatMinCost;
                delete Memory.visuals.combatNumbers;
                delete Memory.visuals.combatNumberThreshold;

                // Optional cleanup
                if (Object.keys(Memory.visuals).length === 0) {
                    delete Memory.visuals;
                }
            }

            console.log('Debug visuals combat mode DISABLED');
            return 'Debug visuals combat mode DISABLED';
        },
        configurable: true
    });

    Object.defineProperty(global, 'debugoncombat', {
        get: function() {
            Memory.debugCombat = true;
            console.log('Combat Debug mode ENABLED');
            return 'Combat Debug mode ENABLED';
        },
        configurable: true
    });

    Object.defineProperty(global, 'debugoffcombat', {
        get: function() {
            delete Memory.debugCombat;
            console.log('Combat Debug mode DISABLED');
            return 'Combat Debug mode DISABLED';
        },
        configurable: true
    });

    global.debugcaton = function(name) {
        const key = ('' + name).trim();
        if (!key) return 'Usage: debugcaton(\"category\")';
        Memory.debug = true;
        const cats = ensureDebugCategories();
        cats[key] = true;
        return `Debug categories enabled: ${Object.keys(cats).filter(k => cats[k]).sort().join(', ') || '(none)'}`;
    };

    global.debugcatoff = function(name) {
        const key = ('' + name).trim();
        if (!key) return 'Usage: debugcatoff(\"category\")';
        const cats = ensureDebugCategories();
        delete cats[key];
        return `Debug categories enabled: ${Object.keys(cats).filter(k => cats[k]).sort().join(', ') || '(none)'}`;
    };

    global.debugcats = function() {
        const available = getAvailableDebugCategories();
        if (!Memory.debugCategories || typeof Memory.debugCategories !== 'object') {
            return `Debug categories enabled: (all) | available: ${available.join(', ') || '(none)'}`;
        }
        const enabled = Object.keys(Memory.debugCategories).filter(k => Memory.debugCategories[k]).sort();
        return `Debug categories enabled: ${enabled.join(', ') || '(none)'} | available: ${available.join(', ') || '(none)'}`;
    };

    global.debugall = function() {
        Memory.debug = true;
        delete Memory.debugCategories;
        return 'Debug categories cleared (all enabled)';
    };

    global.clearflags = function(prefix) {
        let count = 0;

        for (const name in Game.flags) {
            if (!prefix || name.startsWith(prefix)) {
                Game.flags[name].remove();
                count++;
            }
        }

        console.log(`Removed ${count} flag(s).`);
        return `Removed ${count} flag(s).`;
    };
};
