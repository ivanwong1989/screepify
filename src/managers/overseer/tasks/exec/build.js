const helpers = require('managers_overseer_tasks_exec__helpers');
const execGatherTask = require('managers_overseer_tasks_exec_gather');

module.exports = function execBuildTask(ctx) {
    const { creep, mission, room } = ctx;
    helpers.updateState(creep);
    if (creep.memory.taskState === 'working') {
        const targetId = mission.targetId || (mission.targetIds && mission.targetIds[0]);
        const target = targetId ? helpers.getCachedObject(creep.room, targetId) : null;
        if (target) return { type: 'build', targetId: target.id };

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
