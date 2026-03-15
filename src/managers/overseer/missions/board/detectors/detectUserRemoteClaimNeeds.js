const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');
const contractBridge = require('managers_overseer_missions_board_detectors_detectorContractBridge');
const missionUserRemoteClaim = require('managers_overseer_missions_board_types_mission.user.remote.claim');

function run({ room, intel, context, missionBoard }) {
    if (!room || !intel || !missionBoard) return;
    if (!missionThrottle.shouldRunDetector('userRemoteClaim', room.name, Game.time)) return;
    contractBridge.runGeneratorAsTyped({
        room,
        intel,
        context,
        missionBoard,
        namespace: 'userRemoteClaim',
        type: 'userRemoteClaim',
        generate: missionUserRemoteClaim.generate,
        mapContract: (contract) => ({
            sponsorRoom: room.name,
            targetRoom: room.name,
            userMissionId: contract && contract.data ? contract.data.userMissionId : null
        })
    });
}

module.exports = {
    type: 'userRemoteClaim',
    run
};
