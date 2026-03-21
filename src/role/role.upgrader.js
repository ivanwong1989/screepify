const execGatherTask = require('managers_overseer_tasks_exec_gather');
const vacateSource = require('managers_overseer_tasks_exec__policy_vacate_source');
const movement = require('utils_movement');

function isUpgraderDebugEnabled(creep) {
    if (!Memory || !Memory.debugUpgrader) return false;
    if (Memory.debugUpgrader === true) return true;
    if (!creep) return false;
    if (creep.name && Memory.debugUpgrader === creep.name) return true;
    if (creep.memory && creep.memory.room && Memory.debugUpgrader === creep.memory.room) return true;
    if (creep.room && Memory.debugUpgrader === creep.room.name) return true;
    return false;
}

function debugUpgrader(creep, event, extra) {
    if (!isUpgraderDebugEnabled(creep)) return;
    const taskState = creep && creep.memory ? creep.memory.taskState : '?';
    const energy = creep && creep.store ? (creep.store[RESOURCE_ENERGY] || 0) : 0;
    const free = creep && creep.store ? creep.store.getFreeCapacity(RESOURCE_ENERGY) : 0;
    const pos = creep && creep.pos ? `${creep.pos.roomName}:${creep.pos.x},${creep.pos.y}` : '?';
    const line =
        `[Upgrader] ${event} creep=${creep ? creep.name : '?'} ` +
        `state=${taskState || '-'} e=${energy} free=${free} pos=${pos}${extra ? ` ${extra}` : ''}`;
    if (typeof debug === 'function') {
        debug('mission.upgrade', line);
        return;
    }
    console.log(line);
}

function clearUpgraderAssignment(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.missionName;
    delete creep.memory.task;
    delete creep.memory.taskState;
    delete creep.memory._trafficMove;
}

function moveToTarget(creep, target, range) {
    if (!creep || !target) return;
    const pos = target.pos || target;
    const targetRoomName = pos && pos.roomName ? pos.roomName : null;
    const code = movement.planMoveTo(creep, target, {
        range: Number.isFinite(range) ? range : 1,
        maxRooms: (targetRoomName && creep.room && targetRoomName !== creep.room.name) ? 16 : 1
    });
    if (isUpgraderDebugEnabled(creep)) {
        const targetInfo = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)
            ? `${pos.roomName}:${pos.x},${pos.y}`
            : '-';
        debugUpgrader(creep, 'MOVE_PLAN', `target=${targetInfo} range=${Number.isFinite(range) ? range : 1} code=${code}`);
    }
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
    const prev = creep.memory.taskState;

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

    if (prev !== creep.memory.taskState) {
        debugUpgrader(creep, 'STATE_CHANGE', `from=${prev || '-'} to=${creep.memory.taskState}`);
    }
}

function executeIntent(creep, intent) {
    if (!intent || !intent.type) return false;
    debugUpgrader(
        creep,
        'EXEC_INTENT',
        `type=${intent.type} target=${intent.targetId || (intent.targetPos ? `${intent.targetPos.roomName}:${intent.targetPos.x},${intent.targetPos.y}` : '-')} range=${intent.range !== undefined ? intent.range : '-'} policy=${intent._policy || '-'} reason=${intent._reason || '-'}`
    );

    if (intent.type === 'move') {
        const pos = intent.targetPos;
        if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !pos.roomName) return false;
        const targetPos = new RoomPosition(pos.x, pos.y, pos.roomName);
        if (!creep.pos.inRangeTo(targetPos, Number.isFinite(intent.range) ? intent.range : 1)) {
            moveToTarget(creep, targetPos, Number.isFinite(intent.range) ? intent.range : 1);
        } else {
            debugUpgrader(creep, 'MOVE_INTENT_ALREADY_IN_RANGE', `target=${targetPos.roomName}:${targetPos.x},${targetPos.y}`);
        }
        return true;
    }

    const target = intent.targetId ? Game.getObjectById(intent.targetId) : null;
    if (!target) {
        debugUpgrader(creep, 'EXEC_TARGET_MISSING', `type=${intent.type} targetId=${intent.targetId || '-'}`);
        return false;
    }

    switch (intent.type) {
        case 'upgrade': {
            const result = creep.upgradeController(target);
            debugUpgrader(creep, 'UPGRADE_ATTEMPT', `target=${target.id} result=${result}`);
            if (result === ERR_NOT_IN_RANGE) moveToTarget(creep, target, 3);
            return true;
        }
        case 'harvest': {
            const result = creep.harvest(target);
            debugUpgrader(creep, 'HARVEST_ATTEMPT', `target=${target.id} result=${result}`);
            if (result === ERR_NOT_IN_RANGE) moveToTarget(creep, target, 1);
            return true;
        }
        case 'withdraw': {
            const result = creep.withdraw(target, intent.resourceType || RESOURCE_ENERGY);
            debugUpgrader(creep, 'WITHDRAW_ATTEMPT', `target=${target.id} result=${result}`);
            if (result === ERR_NOT_IN_RANGE) moveToTarget(creep, target, 1);
            return true;
        }
        case 'pickup': {
            const result = creep.pickup(target);
            debugUpgrader(creep, 'PICKUP_ATTEMPT', `target=${target.id} result=${result} amount=${target.amount || 0}`);
            if (result === ERR_NOT_IN_RANGE) moveToTarget(creep, target, 1);
            return true;
        }
        default:
            return false;
    }
}

function getUpgradeIntent(creep, mission, room) {
    updateState(creep);
    debugUpgrader(creep, 'INTENT_EVAL', `phase=${creep.memory.taskState || '-'} missionTarget=${mission && mission.targetId ? mission.targetId : '-'}`);

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
            if (move) {
                const targetPos = move.targetPos;
                debugUpgrader(
                    creep,
                    'VACATE_SOURCE_INTENT',
                    `target=${targetPos ? `${targetPos.roomName}:${targetPos.x},${targetPos.y}` : '-'} reason=${move._reason || '-'} policy=${move._policy || '-'}`
                );
                return move;
            }
        }
        debugUpgrader(creep, 'WORKING_UPGRADE_INTENT', `controller=${mission.targetId || '-'}`);
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
    if (gather) {
        debugUpgrader(creep, 'GATHER_INTENT', `type=${gather.type} target=${gather.targetId || '-'}`);
        return gather;
    }

    if ((creep.store[RESOURCE_ENERGY] || 0) > 0) {
        creep.memory.taskState = 'working';
        debugUpgrader(creep, 'GATHER_EMPTY_BUT_HAS_ENERGY', 'switch=working');
        return { type: 'upgrade', targetId: mission.targetId };
    }

    debugUpgrader(creep, 'NO_INTENT', 'reason=no_gather_target');
    return null;
}

const roleUpgrader = {
    run: function(creep) {
        if (!creep || !creep.memory) return;

        debugUpgrader(creep, 'RUN_START', `mission=${creep.memory.missionName || '-'} room=${creep.room ? creep.room.name : '-'}`);

        const missionName = creep.memory.missionName;
        if (!missionName) {
            delete creep.memory.task;
            delete creep.memory.taskState;
            debugUpgrader(creep, 'CLEAR_NO_MISSION');
            return;
        }

        const homeRoomName = creep.memory.room || (creep.room && creep.room.name);
        const homeRoom = homeRoomName ? Game.rooms[homeRoomName] : null;
        const mission = getMissionByName(homeRoom, missionName);
        if (!mission || mission.type !== 'upgrade') {
            debugUpgrader(creep, 'CLEAR_BAD_MISSION', `mission=${missionName} type=${mission && mission.type ? mission.type : '-'}`);
            clearUpgraderAssignment(creep);
            return;
        }

        movement.enableTrafficForBuildWorker(creep);
        delete creep.memory.task;
        const intent = getUpgradeIntent(creep, mission, homeRoom || creep.room);
        if (!intent) {
            debugUpgrader(creep, 'CLEAR_NO_INTENT');
            clearUpgraderAssignment(creep);
            return;
        }
        const handled = executeIntent(creep, intent);
        if (!handled) debugUpgrader(creep, 'INTENT_NOT_HANDLED', `type=${intent.type || '-'}`);
    }
};

module.exports = roleUpgrader;
