const helpers = require('managers_overseer_tasks_exec__helpers');

module.exports = function execDecongestTask(ctx) {
    const { creep, mission } = ctx;
    if (creep.memory.task && creep.memory.task.action === 'move') {
        if (creep.memory.task.targetId) {
            const currentTarget = helpers.getCachedObject(creep.room, creep.memory.task.targetId);
            if (currentTarget && (mission.targetIds || []).includes(currentTarget.id)) {
                if (creep.pos.inRangeTo(currentTarget.pos, 1)) {
                    delete creep.memory.missionName;
                    delete creep.memory.taskState;
                    creep.say('parked');
                    return null;
                }
                return { type: 'move', targetId: currentTarget.id };
            }
        }
        if (creep.memory.task.targetName) {
            const currentTarget = Game.flags[creep.memory.task.targetName];
            if (currentTarget && (mission.targetNames || []).includes(currentTarget.name)) {
                if (creep.pos.inRangeTo(currentTarget.pos, 1)) {
                    delete creep.memory.missionName;
                    delete creep.memory.taskState;
                    creep.say('parked');
                    return null;
                }
                return { type: 'move', targetName: currentTarget.name };
            }
        }
    }

    let targets = [];
    if (mission.targetIds) {
        targets = (mission.targetIds || []).map(id => helpers.getCachedObject(creep.room, id)).filter(t => t);
    } else if (mission.targetNames) {
        targets = (mission.targetNames || []).map(name => Game.flags[name]).filter(t => t);
    }

    if (targets.length > 0) {
        const target = creep.pos.findClosestByRange(targets);
        if (target) {
            if (creep.pos.inRangeTo(target.pos, 1)) {
                delete creep.memory.missionName;
                delete creep.memory.taskState;
                creep.say('parked');
                return null;
            }
            if (target instanceof Flag) {
                return { type: 'move', targetName: target.name };
            }
            return { type: 'move', targetId: target.id };
        }
    }
    return null;
};
