const missionRegistry = require('managers_overseer_missions_board_missionRegistry');
const missionHarvest = require('managers_overseer_missions_board_types_mission.harvest');
const missionSimpleHarvest = require('managers_overseer_missions_board_types_mission.simpleHarvest');
const missionBuild = require('managers_overseer_missions_board_types_mission.build');
const missionRepair = require('managers_overseer_missions_board_types_mission.repair');
const missionFortify = require('managers_overseer_missions_board_types_mission.fortify');
const missionUpgrade = require('managers_overseer_missions_board_types_mission.upgrade');
const missionLogisticsCoreV2 = require('managers_overseer_missions_board_types_mission.logisticsCoreV2');
const missionLogisticsSimpleCore = require('managers_overseer_missions_board_types_mission.logisticsSimpleCore');
const missionLogisticsSimpleMining = require('managers_overseer_missions_board_types_mission.logisticsSimpleMining');
const missionLogisticsMiningV2 = require('managers_overseer_missions_board_types_mission.logisticsMiningV2');
const missionRemoteHarvest = require('managers_overseer_missions_board_types_mission.remoteHarvest');
const missionRemoteHaul = require('managers_overseer_missions_board_types_mission.remoteHaul');
const missionScout = require('managers_overseer_missions_board_types_mission.scout');
const missionMineral = require('managers_overseer_missions_board_types_mission.mineral');
const missionUserRemoteMove2Flag = require('managers_overseer_missions_board_types_mission.userRemoteMove2Flag');
const missionTower = require('managers_overseer_missions_board_types_mission.tower');
const missionRemoteBuild = require('managers_overseer_missions_board_types_mission.remoteBuild');

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

