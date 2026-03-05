const admiralIntel = require('managers_admiral_intel_admiral.intel');
const admiralMissions = require('managers_admiral_missions_admiral.missions');



// ============================
// Debug (toggle with Memory.debugDefense = true)
// ============================
function _milDbgEnabled() {
    return !!(global.Memory && Memory.debugDefense);
}
function _milDbgEvery(n) {
    n = n || 10;
    return (Game.time % n) === 0;
}
function _milDbgLog(msg) {
    if (!_milDbgEnabled()) return;
    if (!_milDbgEvery(10)) return; // throttle
    console.log(msg);
}

/**
 * The Admiral is the military counterpart to the Overseer.
 * It monitors threats and manages combat missions with advanced assessment.
 */
var managerAdmiral = {
    run: function(room) {
        if (!room.memory.admiral) room.memory.admiral = {};

        // 1. Military Intel
        const cache = global.getRoomCache(room);
        const hostiles = cache.hostiles || [];
        const threat = admiralIntel.analyzeThreat(hostiles);
        const budget = room.energyCapacityAvailable;

        // 2. Determine Combat State
        const state = admiralIntel.determineCombatState(hostiles, threat, room);

        
        _milDbgLog(`[MIL][admiral] ${room.name} t=${Game.time} hostiles=${hostiles.length} threat=${threat || '-'} state=${state} cap=${budget}`);
// 3. Generate Missions
        const missions = admiralMissions.generate(room, hostiles, threat, state, budget);

        
        _milDbgLog(`[MIL][admiral] ${room.name} missionsGenerated=${(missions && missions.length) || 0}`);
// 4. Publish to shared mission pool
        if (!room._missions) room._missions = [];
        const _pre = room._missions.length;
        room._missions = room._missions.concat(missions);
        const _post = room._missions.length;
        _milDbgLog(`[MIL][admiral] ${room.name} publish pre=${_pre} add=${(missions && missions.length) || 0} post=${_post}`);
room._combatState = state;
        room.memory.admiral.state = state;

        if (state !== 'PEACE' && missions.length > 0) {
            const m = missions[0];
            const strat = m.data && m.data.strategy ? m.data.strategy : 'N/A';
            const formation = m.data && m.data.formation ? m.data.formation : 'N/A';
            debug('admiral', `[Admiral] Room ${room.name} state: ${state}, Strat: ${strat}, Formation: ${formation}`);
        }
    }
};

module.exports = managerAdmiral;
