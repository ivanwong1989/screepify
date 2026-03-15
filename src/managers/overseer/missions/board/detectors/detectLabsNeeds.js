const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');
const contractBridge = require('managers_overseer_missions_board_detectors_detectorContractBridge');
const missionLabs = require('managers_overseer_missions_board_types_mission.labs');

function run({ room, intel, context, missionBoard }) {
    if (!room || !intel || !missionBoard) return;
    if (!missionThrottle.shouldRunDetector('labs', room.name, Game.time)) return;
    contractBridge.runGeneratorAsTyped({
        room,
        intel,
        context,
        missionBoard,
        namespace: 'labs',
        type: 'labsManaged',
        generate: missionLabs.generate,
        mapContract: () => ({ sponsorRoom: room.name, targetRoom: room.name })
    });
}

module.exports = {
    type: 'labs',
    run
};
