const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');
const contractBridge = require('managers_overseer_missions_board_detectors_detectorContractBridge');
const missionUserDismantle = require('managers_overseer_missions_board_types_mission.user.dismantle');

function run({ room, intel, context, missionBoard }) {
    if (!room || !intel || !missionBoard) return;
    if (!missionThrottle.shouldRunDetector('userDismantle', room.name, Game.time)) return;
    contractBridge.runGeneratorAsTyped({
        room,
        intel,
        context,
        missionBoard,
        namespace: 'userDismantle',
        type: 'userDismantle',
        generate: missionUserDismantle.generate,
        mapContract: (contract) => ({
            sponsorRoom: room.name,
            targetRoom: room.name,
            userMissionId: contract && contract.data ? contract.data.userMissionId : null
        })
    });
}

module.exports = {
    type: 'userDismantle',
    run
};
