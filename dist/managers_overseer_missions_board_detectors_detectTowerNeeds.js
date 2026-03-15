const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');

const TOWER_POLICY_NAMES = [
    'tower:defense',
    'tower:heal',
    'tower:repair'
];

function run({ room, intel, context, missionBoard }) {
    if (!room || !intel || !missionBoard) return;
    if (!missionThrottle.shouldRunDetector('tower', room.name, Game.time)) return;

    const hasHostiles = Array.isArray(intel.hostiles) && intel.hostiles.length > 0;
    const live = missionBoard.listLiveByRoom(room.name);
    const existingManaged = live.some(m => m && m.type === 'towerManaged');
    if (!hasHostiles && existingManaged && !missionThrottle.shouldRunDetector('towerPassive', room.name, Game.time)) {
        return;
    }

    for (let i = 0; i < TOWER_POLICY_NAMES.length; i++) {
        const policyName = TOWER_POLICY_NAMES[i];
        missionBoard.createMission('towerManaged', {
            sponsorRoom: room.name,
            targetRoom: room.name,
            namespace: 'tower',
            policyName
        }, { room, intel, context });
    }
}

module.exports = {
    type: 'tower',
    run
};
