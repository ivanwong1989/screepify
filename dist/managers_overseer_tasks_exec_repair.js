const helpers = require('managers_overseer_tasks_exec__helpers');
const execGatherTask = require('managers_overseer_tasks_exec_gather');
const vacateSource = require('managers_overseer_tasks_exec__policy_vacate_source');

module.exports = function execRepairTask(ctx) {
    const { creep, mission, room } = ctx;
    helpers.updateState(creep);
    if (creep.memory.taskState === 'working') {
        const targetId = mission.targetId || (mission.targetIds && mission.targetIds[0]);
        const target = targetId ? helpers.getCachedObject(creep.room, targetId) : null;
        if (target && target.hits < target.hitsMax) {
            const move = vacateSource.getVacateSourceMoveIntent(
                creep,
                'repair',
                target,
                3,
                {
                    allowRolesNearSource: ['miner', 'staticMiner', 'remoteHarvester', 'remote_miner', 'harvester_remote'],
                    forbidRangeFromSource: 1,
                    useOccupancyCheck: true,
                    allowedSourceInfraTypes: [STRUCTURE_CONTAINER, STRUCTURE_ROAD, STRUCTURE_LINK],
                    requireTargetNearSource: true
                }
            );
            if (move) return move;
            return { type: 'repair', targetId: target.id };
        }

        delete creep.memory.missionName;
        delete creep.memory.taskState;
        return null;
    }

    let task = null;
    if (mission.data && mission.data.sourceId) {
        task = execGatherTask({ creep, room, options: { allowedIds: [mission.data.sourceId] } });
    } else {
        const allowedIds = (mission.data && mission.data.sourceIds) ? mission.data.sourceIds : null;
        const excludeIds = (mission.data && mission.data.targetIds) ? mission.data.targetIds : null;
        task = execGatherTask({ creep, room, options: { allowedIds, excludeIds } });
    }

    if (!task) {
        delete creep.memory.missionName;
        delete creep.memory.taskState;
        return null;
    }
    return task;
};
