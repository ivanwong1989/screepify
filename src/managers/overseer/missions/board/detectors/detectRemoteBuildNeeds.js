const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');
const contractBridge = require('managers_overseer_missions_board_detectors_detectorContractBridge');
const missionRemoteBuild = require('managers_overseer_missions_board_types_mission.remote.build');

function run({ room, intel, context, missionBoard }) {
    if (!room || !intel || !missionBoard) return;
    if (!missionThrottle.shouldRunDetector('remoteBuild', room.name, Game.time)) return;
    contractBridge.runGeneratorAsTyped({
        room,
        intel,
        context,
        missionBoard,
        namespace: 'remoteBuild',
        type: 'remoteBuildManaged',
        generate: missionRemoteBuild.generate,
        mapContract: (contract) => ({
            sponsorRoom: room.name,
            targetRoom: (contract && contract.targetPos && contract.targetPos.roomName) || room.name
        })
    });
}

module.exports = {
    type: 'remoteBuild',
    run
};
