const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');
const contractBridge = require('managers_overseer_missions_board_detectors_detectorContractBridge');
const missionUserRemoteMove2Flag = require('managers_overseer_missions_board_types_mission.user.remote.move2flag');

function run({ room, intel, context, missionBoard }) {
    if (!room || !intel || !missionBoard) return;
    if (!missionThrottle.shouldRunDetector('userRemoteMove2Flag', room.name, Game.time)) return;
    contractBridge.runGeneratorAsTyped({
        room,
        intel,
        context,
        missionBoard,
        namespace: 'userRemoteMove2Flag',
        type: 'userRemoteMove2Flag',
        generate: missionUserRemoteMove2Flag.generate,
        mapContract: (contract) => ({
            sponsorRoom: room.name,
            targetRoom: room.name,
            userMissionId: contract && contract.data ? contract.data.userMissionId : null
        })
    });
}

module.exports = {
    type: 'userRemoteMove2Flag',
    run
};
