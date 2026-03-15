const detectHarvestNeeds = require('managers_overseer_missions_board_detectors_detectHarvestNeeds');
const detectBuildNeeds = require('managers_overseer_missions_board_detectors_detectBuildNeeds');
const detectRepairNeeds = require('managers_overseer_missions_board_detectors_detectRepairNeeds');
const detectUpgradeNeeds = require('managers_overseer_missions_board_detectors_detectUpgradeNeeds');
const detectIdleUpgradeNeeds = require('managers_overseer_missions_board_detectors_detectIdleUpgradeNeeds');
const detectLogisticsNeeds = require('managers_overseer_missions_board_detectors_detectLogisticsNeeds');
const detectLogisticsFleetNeeds = require('managers_overseer_missions_board_detectors_detectLogisticsFleetNeeds');
const detectRemoteHarvestNeeds = require('managers_overseer_missions_board_detectors_detectRemoteHarvestNeeds');
const detectRemoteHaulNeeds = require('managers_overseer_missions_board_detectors_detectRemoteHaulNeeds');
const detectScoutNeeds = require('managers_overseer_missions_board_detectors_detectScoutNeeds');
const detectMineralNeeds = require('managers_overseer_missions_board_detectors_detectMineralNeeds');
const detectDecongestNeeds = require('managers_overseer_missions_board_detectors_detectDecongestNeeds');
const detectTowerNeeds = require('managers_overseer_missions_board_detectors_detectTowerNeeds');
const detectRemoteBuildNeeds = require('managers_overseer_missions_board_detectors_detectRemoteBuildNeeds');
const detectRemoteRepairNeeds = require('managers_overseer_missions_board_detectors_detectRemoteRepairNeeds');
const detectUserRemoteReserveNeeds = require('managers_overseer_missions_board_detectors_detectUserRemoteReserveNeeds');
const detectUserRemoteClaimNeeds = require('managers_overseer_missions_board_detectors_detectUserRemoteClaimNeeds');
const detectUserRemoteMove2FlagNeeds = require('managers_overseer_missions_board_detectors_detectUserRemoteMove2FlagNeeds');
const detectLabsNeeds = require('managers_overseer_missions_board_detectors_detectLabsNeeds');
const detectUserDismantleNeeds = require('managers_overseer_missions_board_detectors_detectUserDismantleNeeds');
const detectUserTransferNeeds = require('managers_overseer_missions_board_detectors_detectUserTransferNeeds');

const detectors = [
    detectHarvestNeeds,
    detectBuildNeeds,
    detectRepairNeeds,
    detectUpgradeNeeds,
    detectIdleUpgradeNeeds,
    detectLogisticsNeeds,
    detectLogisticsFleetNeeds,
    detectRemoteHarvestNeeds,
    detectRemoteHaulNeeds,
    detectScoutNeeds,
    detectMineralNeeds,
    detectDecongestNeeds,
    detectTowerNeeds,
    detectRemoteBuildNeeds,
    // detectRemoteRepairNeeds, // migrated but intentionally disabled for now
    detectUserRemoteReserveNeeds,
    detectUserRemoteClaimNeeds,
    detectUserRemoteMove2FlagNeeds,
    detectLabsNeeds,
    detectUserDismantleNeeds,
    detectUserTransferNeeds
];

function runForRoom(runtime, missionBoard, stats) {
    for (let i = 0; i < detectors.length; i++) {
        const detector = detectors[i];
        if (!detector || typeof detector.run !== 'function') continue;
        const detectorName = detector.type || `detector_${i}`;
        if (stats && stats.detectors) {
            stats.detectors.total = (stats.detectors.total || 0) + 1;
            if (!stats.detectors.byName) stats.detectors.byName = Object.create(null);
            if (!stats.detectors.byName[detectorName]) {
                stats.detectors.byName[detectorName] = { runs: 0, created: 0, errors: 0 };
            }
            stats.detectors.byName[detectorName].runs += 1;
        }

        const createdBefore = stats && stats.create ? (stats.create.created || 0) : 0;
        try {
            detector.run({
                room: runtime.room,
                intel: runtime.intel,
                context: runtime.context,
                missionBoard
            });
            if (stats && stats.detectors) {
                stats.detectors.ran = (stats.detectors.ran || 0) + 1;
                const createdAfter = stats.create ? (stats.create.created || 0) : createdBefore;
                const delta = Math.max(0, createdAfter - createdBefore);
                stats.detectors.byName[detectorName].created += delta;
                if (delta <= 0) {
                    stats.detectors.filtered = (stats.detectors.filtered || 0) + 1;
                    stats.detectors.byName[detectorName].filtered = (stats.detectors.byName[detectorName].filtered || 0) + 1;
                }
            }
        } catch (err) {
            if (stats && stats.detectors) {
                stats.detectors.errors = (stats.detectors.errors || 0) + 1;
                stats.detectors.byName[detectorName].errors += 1;
            }
            if (typeof debug === 'function') {
                debug('missions', `[MissionBoard] detector error type=${detectorName} err=${err && err.message}`);
            }
        }
    }
}

module.exports = {
    runForRoom
};

