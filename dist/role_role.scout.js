const borderNav = require('utils_creepBorderNav');
const roleUniversal = require('role_role.universal');
const execScoutTask = require('managers_overseer_tasks_exec_scout');

function clearScoutAssignment(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.missionName;
    delete creep.memory.task;
    delete creep.memory.taskState;
    delete creep.memory.scout;
    delete creep.memory._scoutState;
}

function getMissionByName(homeRoom, missionName) {
    if (!homeRoom || !missionName) return null;
    if (homeRoom._scoutMissionMapTick !== Game.time || !homeRoom._scoutMissionMap) {
        const map = Object.create(null);
        const missions = Array.isArray(homeRoom._missions) ? homeRoom._missions : [];
        for (let i = 0; i < missions.length; i++) {
            const mission = missions[i];
            if (!mission || !mission.name) continue;
            map[mission.name] = mission;
        }
        homeRoom._scoutMissionMap = map;
        homeRoom._scoutMissionMapTick = Game.time;
    }
    return homeRoom._scoutMissionMap[missionName] || null;
}

function runIntent(creep, intent) {
    if (!intent) {
        delete creep.memory.task;
        delete creep.memory.taskState;
        return;
    }

    if (intent.type === 'move' && intent.targetPos && intent.targetPos.roomName) {
        const x = Number.isFinite(intent.targetPos.x) ? intent.targetPos.x : 25;
        const y = Number.isFinite(intent.targetPos.y) ? intent.targetPos.y : 25;
        const range = Number.isFinite(intent.range) ? intent.range : 1;
        const targetPos = new RoomPosition(x, y, intent.targetPos.roomName);
        borderNav.moveToTarget(creep, targetPos, range);
        return;
    }
}

function parkNearSpawnWhileIdle(creep, homeRoomName) {
    if (!creep || !homeRoomName) return false;
    if (!creep.room || creep.room.name !== homeRoomName) return false;

    const homeRoom = Game.rooms[homeRoomName];
    if (!homeRoom) return false;
    const spawns = homeRoom.find(FIND_MY_SPAWNS);
    if (!spawns || spawns.length <= 0) return false;

    const anchorSpawn = creep.pos.findClosestByRange(spawns);
    if (!anchorSpawn) return false;

    const range = creep.pos.getRangeTo(anchorSpawn.pos);
    const parkingMin = 4;
    const parkingMax = 6;
    if (range >= parkingMin && range <= parkingMax) return true;

    borderNav.moveToTarget(creep, anchorSpawn, 5);
    return true;
}

const roleScout = {
    run: function(creep) {
        if (!creep || !creep.memory) return;

        const missionName = creep.memory.missionName;
        if (!missionName) {
            roleUniversal.run(creep);
            return;
        }

        const homeRoomName = creep.memory.room || (creep.room && creep.room.name);
        const homeRoom = homeRoomName ? Game.rooms[homeRoomName] : null;
        const mission = getMissionByName(homeRoom, missionName);
        if (!mission) {
            clearScoutAssignment(creep);
            return;
        }

        if (mission.type !== 'scout') {
            roleUniversal.run(creep);
            return;
        }

        delete creep.memory.task;
        delete creep.memory.taskState;

        const intent = execScoutTask({ creep, mission, room: homeRoom });
        runIntent(creep, intent);
        if (!intent) {
            const data = mission.data || {};
            const sponsorRoom = data.sponsorRoom || homeRoomName;
            const targetRoom = data.targetRoom || null;
            if (!targetRoom) parkNearSpawnWhileIdle(creep, sponsorRoom);
        }
    }
};

module.exports = roleScout;
