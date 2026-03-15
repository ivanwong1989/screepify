const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');

function run({ room, intel, context, missionBoard }) {
    if (!room || !missionBoard || !intel) return;
    if (context && context.opState === 'EMERGENCY') return;
    const existing = missionBoard.listLiveByRoom(room.name).filter(m => m.type === 'logisticsFleet').length;
    if (existing > 0 && !missionThrottle.shouldRunDetector('logisticsFleet', room.name, Game.time)) return;

    const efficientSources = context && context.efficientSources ? context.efficientSources : null;
    if (!efficientSources || efficientSources.size <= 0) return;

    missionBoard.createMission('logisticsFleet', {
        sponsorRoom: room.name,
        targetRoom: room.name,
        priority: 85
    }, { room, intel, context });
}

module.exports = {
    type: 'logisticsFleet',
    run
};
