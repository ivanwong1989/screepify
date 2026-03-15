const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');

function run({ room, context, missionBoard }) {
    if (!room || !missionBoard) return;
    if (context && context.opState === 'EMERGENCY') return;
    if (!room.controller || !room.controller.my || room.controller.level < 3) return;
    if (Memory.remoteMissionsEnabled === false) return;
    if (!missionThrottle.shouldRunDetector('scout', room.name, Game.time)) return;

    missionBoard.createMission('scout', {
        sponsorRoom: room.name,
        priority: 20
    }, { room, intel: null, context });
}

module.exports = {
    type: 'scout',
    run
};
