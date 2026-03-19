const borderNav = require('utils_creepBorderNav');
const execGatherTask = require('managers_overseer_tasks_exec_gather');
const vacateSource = require('managers_overseer_tasks_exec__policy_vacate_source');

function clearUpgraderAssignment(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.missionName;
    delete creep.memory.task;
    delete creep.memory.taskState;
}

function getMissionByName(homeRoom, missionName) {
    if (!homeRoom || !missionName) return null;
    if (homeRoom._upgraderMissionMapTick !== Game.time || !homeRoom._upgraderMissionMap) {
        const map = Object.create(null);
        const missions = Array.isArray(homeRoom._missions) ? homeRoom._missions : [];
        for (let i = 0; i < missions.length; i++) {
            const mission = missions[i];
            if (!mission || !mission.name) continue;
            map[mission.name] = mission;
        }
        homeRoom._upgraderMissionMap = map;
        homeRoom._upgraderMissionMapTick = Game.time;
    }
    return homeRoom._upgraderMissionMap[missionName] || null;
}

function updateState(creep) {
    const used = creep.store.getUsedCapacity(RESOURCE_ENERGY);
    const free = creep.store.getFreeCapacity(RESOURCE_ENERGY);

    if (creep.memory.taskState === 'working' && used === 0) {
        creep.memory.taskState = 'idle';
    }
    if (creep.memory.taskState === 'gathering' && free === 0) {
        creep.memory.taskState = 'idle';
    }
    if (creep.memory.taskState === 'idle' || creep.memory.taskState === 'init' || !creep.memory.taskState) {
        if (used > 0) {
            creep.memory.taskState = 'working';
        } else {
            creep.memory.taskState = 'gathering';
        }
    }
}

function executeIntent(creep, intent) {
    if (!intent || !intent.type) return false;

    if (intent.type === 'move') {
        const pos = intent.targetPos;
        if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !pos.roomName) return false;
        const targetPos = new RoomPosition(pos.x, pos.y, pos.roomName);
        if (!creep.pos.inRangeTo(targetPos, Number.isFinite(intent.range) ? intent.range : 1)) {
            borderNav.moveToTarget(creep, targetPos, Number.isFinite(intent.range) ? intent.range : 1);
        }
        return true;
    }

    const target = intent.targetId ? Game.getObjectById(intent.targetId) : null;
    if (!target) return false;

    switch (intent.type) {
        case 'upgrade': {
            const result = creep.upgradeController(target);
            if (result === ERR_NOT_IN_RANGE) borderNav.moveToTarget(creep, target, 3);
            return true;
        }
        case 'harvest': {
            const result = creep.harvest(target);
            if (result === ERR_NOT_IN_RANGE) borderNav.moveToTarget(creep, target, 1);
            return true;
        }
        case 'withdraw': {
            const result = creep.withdraw(target, intent.resourceType || RESOURCE_ENERGY);
            if (result === ERR_NOT_IN_RANGE) borderNav.moveToTarget(creep, target, 1);
            return true;
        }
        case 'pickup': {
            const result = creep.pickup(target);
            if (result === ERR_NOT_IN_RANGE) borderNav.moveToTarget(creep, target, 1);
            return true;
        }
        default:
            return false;
    }
}

function getUpgradeIntent(creep, mission, room) {
    updateState(creep);

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

    const gather = execGatherTask({
        creep,
        room,
        options: {
            preferNearestAvailable: true,
            disallowSourceHarvest: true
        }
    });
    if (gather) return gather;

    if ((creep.store[RESOURCE_ENERGY] || 0) > 0) {
        creep.memory.taskState = 'working';
        return { type: 'upgrade', targetId: mission.targetId };
    }

    return null;
}

const roleUpgrader = {
    run: function(creep) {
        if (!creep || !creep.memory) return;

        const missionName = creep.memory.missionName;
        if (!missionName) {
            delete creep.memory.task;
            delete creep.memory.taskState;
            return;
        }

        const homeRoomName = creep.memory.room || (creep.room && creep.room.name);
        const homeRoom = homeRoomName ? Game.rooms[homeRoomName] : null;
        const mission = getMissionByName(homeRoom, missionName);
        if (!mission || mission.type !== 'upgrade') {
            clearUpgraderAssignment(creep);
            return;
        }

        delete creep.memory.task;
        const intent = getUpgradeIntent(creep, mission, homeRoom || creep.room);
        if (!intent) {
            clearUpgraderAssignment(creep);
            return;
        }
        executeIntent(creep, intent);
    }
};

module.exports = roleUpgrader;
