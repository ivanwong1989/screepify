const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');

function run({ room, intel, context, missionBoard }) {
    if (!room || !missionBoard) return;
    if (!intel || !intel.controller || !intel.controller.my) return;
    if (context && context.opState === 'EMERGENCY') return;
    if (!missionThrottle.shouldRunDetector('upgrade', `${room.name}:idle`, Game.time)) return;

    missionBoard.createMission('upgrade', {
        sponsorRoom: room.name,
        targetRoom: room.name,
        controllerId: intel.controller.id,
        idle: true,
        priority: -100
    }, { room, intel, context });
}

module.exports = {
    type: 'idleUpgrade',
    run
};
