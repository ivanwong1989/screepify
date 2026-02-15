module.exports = function registerHelpConsole() {
    Object.defineProperty(global, 'help', {
        get: function() {
            const lines = [
                'Console commands:',
                'debugon           - enable debug logging',
                'debugoff          - disable debug logging',
                'debugoncombat     - enable combat debug logging',
                'debugoffcombat    - disable combat debug logging',
                'debugcaton(\"cat\")  - enable a debug category (allowlist)',
                'debugcatoff(\"cat\") - disable a debug category',
                'debugcats()       - list enabled and available debug categories',
                'debugall          - clear category filter (log all)',
                'economy()         - override per-room economy state (upgrade/stockpile)',
                'market()          - manage terminal auto-trading',
                'remote()          - manage remote mission toggles',
                'allyAdd(\"Name\")    - add an ally by player name',
                'allyRemove(\"Name\") - remove an ally by player name',
                'allyList()        - show current allies',
                'mission()         - manage user-controlled missions',
                'flag directives:',
                '  Parking*        - decongest parking flags',
                '  Dismantle flags are deprecated; use mission()'
            ];
            for (const line of lines) console.log(line);
            return `Done`;
        },
        configurable: true
    });
};
