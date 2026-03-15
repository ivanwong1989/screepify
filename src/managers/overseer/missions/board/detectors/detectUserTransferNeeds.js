const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');
const contractBridge = require('managers_overseer_missions_board_detectors_detectorContractBridge');
const missionUserTransfer = require('managers_overseer_missions_board_types_mission.user.transfer');

function run({ room, intel, context, missionBoard }) {
    if (!room || !intel || !missionBoard) return;
    if (!missionThrottle.shouldRunDetector('userTransfer', room.name, Game.time)) return;
    contractBridge.runGeneratorAsTyped({
        room,
        intel,
        context,
        missionBoard,
        namespace: 'userTransfer',
        type: 'userTransfer',
        generate: missionUserTransfer.generate,
        mapContract: (contract) => ({
            sponsorRoom: room.name,
            targetRoom: (contract && contract.data && contract.data.targetRoom) || room.name,
            userMissionId: contract && contract.data ? contract.data.userMissionId : null
        })
    });
}

module.exports = {
    type: 'userTransfer',
    run
};
