const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');

function run({ room, missionBoard }) {
    if (!room || !missionBoard) return;
    if (!missionThrottle.shouldRunDetector('decongest', room.name, Game.time)) return;

    const parkingFlags = room.find(FIND_FLAGS, { filter: f => f.name && f.name.startsWith('Parking') });
    if (parkingFlags.length === 0) return;

    missionBoard.createMission('decongest', {
        sponsorRoom: room.name,
        priority: -200
    }, { room, intel: null, context: null });
}

module.exports = {
    type: 'decongest',
    run
};
