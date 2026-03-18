const roleUniversal = require('role_role.universal');

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
        if (!mission) {
            clearUpgraderAssignment(creep);
            return;
        }

        if (mission.type !== 'upgrade') {
            clearUpgraderAssignment(creep);
            return;
        }

        roleUniversal.run(creep);
    }
};

module.exports = roleUpgrader;
