const solo = require('managers_admiral_tactics_assault_solo_controller');
const duo = require('managers_admiral_tactics_assault_duo_controller');

function runAssault(creep, mission, context) {
    if (!creep || !mission) return null;
    const mode = mission.data && mission.data.mode;
    if (mode === 'DUO') return null;
    return solo.run(creep, mission, context);
}

function executeAssault(creep, mission, context) {
    const task = runAssault(creep, mission, context);
    if (task && creep && creep.memory) {
        creep.memory.task = task;
    }
}

module.exports = {
    runAssault,
    executeAssault,
    planForPair: function(mission, leader, support, context) {
        const mode = mission && mission.data && mission.data.mode;
        if (mode !== 'DUO') return null;
        return duo.planForPair(mission, leader, support, context);
    }
};
