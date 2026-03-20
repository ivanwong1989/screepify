const roleUniversal = require('role_role.universal');
const movement = require('utils_movement');
const scoutUtils = require('managers_overseer_utils_overseer.scout');

function clearScoutAssignment(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.missionName;
    delete creep.memory.task;
    delete creep.memory.taskState;
    delete creep.memory.scout;
    delete creep.memory._scoutState;
    delete creep.memory._trafficMove;
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
        if (targetPos.roomName === creep.room.name) {
            movement.planMoveTo(creep, targetPos, { range, maxRooms: 1 });
            return;
        }
        planMoveTowardRoom(creep, targetPos.roomName);
        return;
    }
}

function getBorderMoveDirection(pos) {
    if (!pos) return null;
    if (pos.x === 0) return LEFT;
    if (pos.x === 49) return RIGHT;
    if (pos.y === 0) return TOP;
    if (pos.y === 49) return BOTTOM;
    return null;
}

function planMoveTowardRoom(creep, targetRoomName) {
    if (!creep || !creep.room || !targetRoomName) return ERR_INVALID_ARGS;
    if (creep.room.name === targetRoomName) return OK;

    const exitDir = creep.room.findExitTo(targetRoomName);
    if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) return ERR_NO_PATH;

    const borderDir = getBorderMoveDirection(creep.pos);
    if (borderDir && borderDir === exitDir) {
        return movement.planMove(creep, borderDir);
    }

    const exits = creep.room.find(exitDir);
    if (!exits || exits.length <= 0) return ERR_NO_PATH;
    const exitPos = creep.pos.findClosestByRange(exits);
    if (!exitPos) return ERR_NO_PATH;

    return movement.planMoveTo(creep, exitPos, { range: 0, maxRooms: 1 });
}

function executeScoutMission(creep, mission, homeRoom) {
    const data = mission.data || {};
    const log = (msg) => debug('mission.scout', `[ScoutTask] ${creep.name} ${msg}`);

    const sponsorRoom = data.sponsorRoom || (homeRoom && homeRoom.name) || (creep.memory && creep.memory.room) || creep.room.name;
    const rooms = Array.isArray(data.rooms) ? data.rooms : [];
    const interval = Number.isFinite(data.interval) ? data.interval : 500;
    const holdTime = Number.isFinite(data.holdTime) ? data.holdTime : 10;
    const targetRoom = data.targetRoom || null;

    creep.memory.scout = {
        sponsorRoom,
        rooms,
        interval,
        holdTime,
        targetRoom,
        adjacentOnly: true
    };

    if (!creep.memory._scoutState) creep.memory._scoutState = {};
    const st = creep.memory._scoutState;
    if (!st._lastLogSig) st._lastLogSig = null;

    const logOnce = (sig, msg) => {
        if (st._lastLogSig === sig) return;
        st._lastLogSig = sig;
        log(msg);
    };

    if (!targetRoom) {
        st.targetRoom = null;
        st.arrivalTime = null;
        st._scoutMarked = false;

        logOnce(
            `idle:${sponsorRoom}`,
            `idle sponsor=${sponsorRoom} rooms=${rooms.length} interval=${interval} hold=${holdTime}`
        );

        if (creep.room.name !== sponsorRoom) {
            return {
                type: 'move',
                targetPos: { x: 25, y: 25, roomName: sponsorRoom },
                range: 24
            };
        }

        return null;
    }

    if (st.targetRoom !== targetRoom) {
        st.targetRoom = targetRoom;
        st.arrivalTime = null;
        st._scoutMarked = false;
        logOnce(`retarget:${targetRoom}`, `target=${targetRoom} sponsor=${sponsorRoom}`);
    }

    if (creep.room.name !== targetRoom) {
        return {
            type: 'move',
            targetPos: { x: 25, y: 25, roomName: targetRoom },
            range: 24
        };
    }

    if (!st.arrivalTime) st.arrivalTime = Game.time;

    if (!st._scoutMarked) {
        scoutUtils.recordScoutIntel(sponsorRoom, creep.room, { setLastScout: true });
        st._scoutMarked = true;

        logOnce(
            `arrive:${targetRoom}:${st.arrivalTime}`,
            `arrived room=${targetRoom} hold=${holdTime}`
        );
    } else {
        scoutUtils.recordScoutIntel(sponsorRoom, creep.room, { setLastScout: false });
    }

    const elapsed = Game.time - st.arrivalTime;
    if (elapsed < holdTime) return null;

    st.arrivalTime = null;
    st._scoutMarked = false;
    logOnce(`complete:${targetRoom}:${Game.time}`, `complete room=${targetRoom} elapsed=${elapsed}`);

    return null;
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

    movement.planMoveTo(creep, anchorSpawn, { range: 5, maxRooms: 1 });
    return true;
}

const roleScout = {
    run: function(creep) {
        if (!creep || !creep.memory) return;
        movement.enableTrafficForBuildWorker(creep);

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

        const intent = executeScoutMission(creep, mission, homeRoom);
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
