const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');
const contractBridge = require('managers_overseer_missions_board_detectors_detectorContractBridge');
const missionUserRemoteReserve = require('managers_overseer_missions_board_types_mission.user.remote.reserve');

function run({ room, intel, context, missionBoard }) {
    if (!room || !intel || !missionBoard) return;
    if (!missionThrottle.shouldRunDetector('userRemoteReserve', room.name, Game.time)) return;
    contractBridge.runGeneratorAsTyped({
        room,
        intel,
        context,
        missionBoard,
        namespace: 'userRemoteReserve',
        type: 'userRemoteReserve',
        generate: missionUserRemoteReserve.generate,
        mapContract: (contract) => ({
            sponsorRoom: room.name,
            targetRoom: room.name,
            userMissionId: contract && contract.data ? contract.data.userMissionId : null
        })
    });
}

module.exports = {
    type: 'userRemoteReserve',
    run
};
