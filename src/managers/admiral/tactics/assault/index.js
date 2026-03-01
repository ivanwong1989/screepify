const solo = require('managers_admiral_tactics_assault_solo_controller');
const duo = require('managers_admiral_tactics_assault_duo_controller');

function planForPair(mission, leader, support, context) {
    const mode = mission && mission.data && mission.data.mode;
    if (mode !== 'DUO') return null;
    return duo.planForPair(mission, leader, support, context);
}

function planForSolo(mission, creep, context) {
    const data = mission && mission.data ? mission.data : {};
    const mode = data.mode;

    // If DUO, this function should not handle it
    if (mode === 'DUO') return null;

    // ✅ All SOLO missions (including dismantle) use the SOLO controller.
    // Behaviour differences are implemented inside the solo controller by reading mission.data.assaultMode.
    return solo.planForSolo(mission, creep, context);
}

/**
 * Backward-compatible executor for old call-sites:
 * - Assigns creep.memory.task for SOLO missions
 * - DUO missions are handled by the duo driver (military tasker) and return null here
 */
function executeAssault(creep, mission, context) {
    if (!creep || !mission) return null;

    const data = mission.data || {};
    if (data.mode === 'DUO') return null;

    const task = planForSolo(mission, creep, context);
    if (task && creep && creep.memory) {
        creep.memory.task = task;
    }
    return task;
}

module.exports = {
    executeAssault,
    planForPair,
    planForSolo
};
