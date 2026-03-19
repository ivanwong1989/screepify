const helpers = require('managers_overseer_tasks_exec__helpers');
const execGatherTask = require('managers_overseer_tasks_exec_gather');
const vacateSource = require('managers_overseer_tasks_exec__policy_vacate_source');

module.exports = function execUpgradeTask(ctx) {
    const { creep, mission, room } = ctx;
    helpers.updateState(creep, RESOURCE_ENERGY, { requireFull: true, allowPartialWork: true });
    if (creep.memory.taskState === 'working') {
        const controller = creep.room && creep.room.controller;
        if (controller) {
            const move = vacateSource.getVacateSourceMoveIntent(
                creep,
                'upgrade',
                controller,
                3,
                {
                    allowRolesNearSource: ['miner', 'staticMiner', 'remoteHarvester', 'remote_miner', 'harvester_remote'],
                    forbidRangeFromSource: 1,
                    useOccupancyCheck: true
                }
            );
            if (move) return move;
        }
        return { type: 'upgrade', targetId: mission.targetId };
    }

    const task = execGatherTask({
        creep,
        room,
        options: {
            preferNearestAvailable: true,
            disallowSourceHarvest: true
        }
    });
    if (!task) {
        if ((creep.store[RESOURCE_ENERGY] || 0) > 0) {
            creep.memory.taskState = 'working';
            return { type: 'upgrade', targetId: mission.targetId };
        }
        delete creep.memory.missionName;
        delete creep.memory.taskState;
        return null;
    }
    return task;
};
