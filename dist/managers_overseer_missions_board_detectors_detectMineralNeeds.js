const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');

function run({ room, intel, context, missionBoard }) {
    if (!room || !intel || !missionBoard) return;
    if (context && context.opState === 'EMERGENCY') return;
    if (!missionThrottle.shouldRunDetector('mineral', room.name, Game.time)) return;

    const minerals = Array.isArray(intel.minerals) ? intel.minerals : [];
    for (let i = 0; i < minerals.length; i++) {
        const mineral = minerals[i];
        if (!mineral || !mineral.id) continue;
        if (!mineral.hasExtractor) continue;
        if (mineral.mineralAmount <= 0) continue;
        if (mineral.ticksToRegeneration && mineral.ticksToRegeneration > 0) continue;
        if ((mineral.availableSpaces || 0) <= 0) continue;

        missionBoard.createMission('mineral', {
            sponsorRoom: room.name,
            mineralId: mineral.id,
            priority: 40
        }, { room, intel, context });
    }
}

module.exports = {
    type: 'mineral',
    run
};
