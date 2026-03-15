const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');

function shouldRun(roomName, missionBoard, room, intel) {
    if (!room || !room.controller || !room.controller.my) return false;
    const existing = missionBoard.listLiveByRoom(roomName).filter(m => m.type === 'harvest').length;
    const sourceCount = intel && Array.isArray(intel.sources)
        ? intel.sources.length
        : room.find(FIND_SOURCES).length;
    if (existing < sourceCount) return true;
    return missionThrottle.shouldRunDetector('harvest', roomName, Game.time);
}

function run({ room, intel, context, missionBoard }) {
    if (!room || !missionBoard) return;
    if (!shouldRun(room.name, missionBoard, room, intel)) return;

    const sources = intel && Array.isArray(intel.sources)
        ? intel.sources
        : room.find(FIND_SOURCES).map(s => ({ id: s.id, availableSpaces: 1 }));

    for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        if (!source || !source.id) continue;
        missionBoard.createMission('harvest', {
            sponsorRoom: room.name,
            targetRoom: room.name,
            sourceId: source.id,
            availableSpaces: source.availableSpaces,
            priority: context && context.opState === 'EMERGENCY' ? 1000 : 100
        }, { room, intel, context });
    }
}

module.exports = {
    type: 'harvest',
    run
};

