const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');
const contractBridge = require('managers_overseer_missions_board_detectors_detectorContractBridge');
const missionRemoteRepair = require('managers_overseer_missions_board_types_mission.remote.repair');

function run({ room, intel, context, missionBoard }) {
    if (!room || !intel || !missionBoard) return;
    if (!missionThrottle.shouldRunDetector('remoteRepair', room.name, Game.time)) return;
    contractBridge.runGeneratorAsContracts({
        room,
        intel,
        context,
        missionBoard,
        namespace: 'remoteRepair',
        generate: missionRemoteRepair.generate
    });
}

module.exports = {
    type: 'remoteRepair',
    run
};
