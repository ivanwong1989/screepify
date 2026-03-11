module.exports = function registerHelpConsole() {
    Object.defineProperty(global, 'help', {
        get: function() {
            const lines = [
                'Console commands:',
                'debugon           - enable debug logging',
                'debugoff          - disable debug logging',
                'debugvison           - enable debug visual logging',
                'debugvisoff          - disable debug visual logging',
                'sparkstatson           - enable sparkline console printing',
                'sparkstatsoff           - disable sparkline console printing',
                'debugviscombaton           - enable debug visual combat logging',
                'debugviscombatoff          - disable debug visual combat logging',
                'debugoncombat     - enable combat debug logging',
                'debugoffcombat    - disable combat debug logging',
                'debugcaton(\"cat\")  - enable a debug category (allowlist)',
                'debugcatoff(\"cat\") - disable a debug category',
                'debugcats()       - list enabled and available debug categories',
                'debugall          - clear category filter (log all)',
                'economy()         - override per-room economy state (upgrade/stockpile)',
                'lab()             - manage labs (react/reverse/purge/idle + boost stocking; shortcuts: lab("react","H","O"), lab("reverse","GH2O"), lab("boost",{XGH2O:"labId"}), lab("purge"), lab("idle"), lab("stop"))',                'remote()          - manage auto-econ remote missions (harvest/haul/build/repair)',
                'allyAdd(\"Name\")    - add an ally by player name',
                'allyRemove(\"Name\") - remove an ally by player name',
                'allyList()        - show current allies',
                'mission()         - manage user-controlled missions',
                'zeadmin()         - show empire/room zeadmin snapshot from heap',
                'dismantleBody()   - set/show dismantle body for assaultMode=dismantle missions (auto/fixed)',
                '  dismantleBody("auto: work move") - auto repeats pattern to capacity (default)',
                '  dismantleBody("fixed: work move") - fixed exact body (no repeat)',
                'attackBody()      - set/show attack flag creep body (auto/fixed)',
                '  attackBody("auto: r m h") - auto repeats pattern to capacity (default)',
                '  attackBody("fixed: r m h") - fixed exact body (no repeat)',
                'attackBodyLeader()  - set/show leader body for assault flag duo (auto/fixed)',
                'attackBodySupport() - set/show support body for assault flag duo (set to enable duo; auto/fixed)',
                'assaultTuning()     - !!! deprecated for now!!! show/set assault tuning overrides (retreatAt, reengageAt, safeDamageRatio, damageBuffer, dangerRadius, supportRange)',
                'clearflags()        - Clear all flags',
                '   clearflags("<prefix>") - Clear all flags matching this prefix',   
                'flag directives:',
                '  Parking*        - decongest parking flags',
                '  W/A/AM          - assault mission flags (W=wait, W1.. waypoints, A=attack, AM=mass attack)',
                '  Y/B/BM          - assault mission flags (Y=wait, Y1.. waypoints, B=attack, BM=mass attack)',
                '  Z/D             - assault dismantler flags (Z=wait, Z1.. waypoints, D=target)'
            ];
            for (const line of lines) console.log(line);
            return `Done`;
        },
        configurable: true
    });
};
