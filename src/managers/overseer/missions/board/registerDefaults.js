const missionRegistry = require('managers_overseer_missions_board_missionRegistry');
const { profRequire } = require('utils_profRequire');

const missionHarvest = profRequire('managers_overseer_missions_board_types_mission.harvest', 'mission.harvest');
const missionSimpleHarvest = profRequire('managers_overseer_missions_board_types_mission.simpleHarvest', 'mission.simpleHarvest');
const missionBuild = profRequire('managers_overseer_missions_board_types_mission.build', 'mission.build');
const missionRepair = profRequire('managers_overseer_missions_board_types_mission.repair', 'mission.repair');
const missionFortify = profRequire('managers_overseer_missions_board_types_mission.fortify', 'mission.fortify');
const missionUpgrade = profRequire('managers_overseer_missions_board_types_mission.upgrade', 'mission.upgrade');
const missionLogisticsCoreV2 = profRequire('managers_overseer_missions_board_types_mission.logisticsCoreV2', 'mission.logisticsCoreV2');
const missionLogisticsSimpleCore = profRequire('managers_overseer_missions_board_types_mission.logisticsSimpleCore', 'mission.logisticsSimpleCore');
const missionLogisticsSimpleMining = profRequire('managers_overseer_missions_board_types_mission.logisticsSimpleMining', 'mission.logisticsSimpleMining');
const missionLogisticsMiningV2 = profRequire('managers_overseer_missions_board_types_mission.logisticsMiningV2', 'mission.logisticsMiningV2');
const missionRemoteHarvest = profRequire('managers_overseer_missions_board_types_mission.remoteHarvest', 'mission.remoteHarvest');
const missionRemoteHaul = profRequire('managers_overseer_missions_board_types_mission.remoteHaul', 'mission.remoteHaul');
const missionRemoteReserve = profRequire('managers_overseer_missions_board_types_mission.remoteReserve', 'mission.remoteReserve');
const missionScout = profRequire('managers_overseer_missions_board_types_mission.scout', 'mission.scout');
const missionMineral = profRequire('managers_overseer_missions_board_types_mission.mineral', 'mission.mineral');
const missionUserRemoteMove2Flag = profRequire('managers_overseer_missions_board_types_mission.userRemoteMove2Flag', 'mission.userRemoteMove2Flag');
const missionTower = profRequire('managers_overseer_missions_board_types_mission.tower', 'mission.tower');
const missionRemoteBuild = profRequire('managers_overseer_missions_board_types_mission.remoteBuild', 'mission.remoteBuild');

let registeredTick = -1;

function ensureRegistered() {
    if (registeredTick === Game.time) return;
    missionRegistry.register('harvest', missionHarvest);
    missionRegistry.register('simpleHarvest', missionSimpleHarvest);
    missionRegistry.register('build', missionBuild);
    missionRegistry.register('repair', missionRepair);
    missionRegistry.register('fortify', missionFortify);
    missionRegistry.register('upgrade', missionUpgrade);
    missionRegistry.register('logisticsCoreV2', missionLogisticsCoreV2);
    missionRegistry.register('logisticsSimpleCore', missionLogisticsSimpleCore);
    missionRegistry.register('logisticsSimpleMining', missionLogisticsSimpleMining);
    missionRegistry.register('logisticsMiningV2', missionLogisticsMiningV2);
    missionRegistry.register('remoteHarvest', missionRemoteHarvest);
    missionRegistry.register('remoteHaul', missionRemoteHaul);
    missionRegistry.register('remoteReserve', missionRemoteReserve);
    missionRegistry.register('scout', missionScout);
    missionRegistry.register('mineral', missionMineral);
    missionRegistry.register('userRemoteMove2Flag', missionUserRemoteMove2Flag);
    missionRegistry.register('tower', missionTower);
    missionRegistry.register('remoteBuild', missionRemoteBuild);
    registeredTick = Game.time;
}

module.exports = {
    ensureRegistered
};

