const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');

function run({ room, intel, context, missionBoard }) {
    if (!room || !missionBoard) return;
    if (context && context.opState === 'EMERGENCY') return;
    if (!missionThrottle.shouldRunDetector('build', room.name, Game.time)) return;

    const sites = intel && Array.isArray(intel.constructionSites)
        ? intel.constructionSites
        : room.find(FIND_MY_CONSTRUCTION_SITES);
    if (!sites || sites.length === 0) return;

    const rcl = (room.controller && room.controller.level) || 1;
    const requiredWork = 5 + Math.max(0, rcl - 3) * 2;

    for (let i = 0; i < sites.length; i++) {
        const site = sites[i];
        if (!site || !site.id) continue;
        missionBoard.createMission('build', {
            sponsorRoom: room.name,
            targetRoom: room.name,
            siteId: site.id,
            requiredWork,
            priority: 60
        }, { room, intel, context });
    }
}

module.exports = {
    type: 'build',
    run
};
