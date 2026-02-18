module.exports = function registerHelpConsole() {
    Object.defineProperty(global, 'help', {
        get: function() {
            const lines = [
                'Console commands:',
                'debugon           - enable debug logging',
                'debugoff          - disable debug logging',
                'debugvison           - enable debug visual logging',
                'debugvisoff          - disable debug visual logging',
                'debugoncombat     - enable combat debug logging',
                'debugoffcombat    - disable combat debug logging',
                'debugcaton(\"cat\")  - enable a debug category (allowlist)',
                'debugcatoff(\"cat\") - disable a debug category',
                'debugcats()       - list enabled and available debug categories',
                'debugall          - clear category filter (log all)',
                'economy()         - override per-room economy state (upgrade/stockpile)',
                'market()          - manage terminal auto-trading',
                'remote()          - manage auto-econ remote missions (harvest/haul/build/repair)',
                'allyAdd(\"Name\")    - add an ally by player name',
                'allyRemove(\"Name\") - remove an ally by player name',
                'allyList()        - show current allies',
                'mission()         - manage user-controlled missions',
                'attackBody()      - set/show attack flag creep body (auto/fixed)',
                '  attackBody("auto: r m h") - auto repeats pattern to capacity (default)',
                '  attackBody("fixed: r m h") - fixed exact body (no repeat)',
                'attackBodyLeader()  - set/show leader body for assault flag duo (auto/fixed)',
                'attackBodySupport() - set/show support body for assault flag duo (set to enable duo; auto/fixed)',
                'assaultTuning()     - show/set assault tuning overrides (retreatAt, reengageAt, safeDamageRatio, damageBuffer, dangerRadius, supportRange)',
                'flag directives:',
                '  Parking*        - decongest parking flags',
                '  W/A/AM          - assault mission flags (W=wait, W1.. waypoints, A=attack, AM=mass attack)',
                '  D/A             - assault dismantler flags (D=wait, W1.. waypoints, A=target)'
            ];
            for (const line of lines) console.log(line);
            return `Done`;
        },
        configurable: true
    });
};
