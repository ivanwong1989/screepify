const scoutUtils = require('managers_overseer_utils_overseer.scout');

module.exports = function execScoutTask(ctx) {
    const { creep, mission, room } = ctx;
    const data = mission.data || {};

    const sponsorRoom = data.sponsorRoom || (room && room.name) || (creep.memory && creep.memory.room) || creep.room.name;
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

    if (!targetRoom) {
        st.targetRoom = null;
        st.arrivalTime = null;
        st._scoutMarked = false;

        if (creep.room.name !== sponsorRoom) {
            creep.memory.task = {
                action: 'move',
                targetPos: { x: 25, y: 25, roomName: sponsorRoom },
                range: 24
            };
        } else {
            if (creep.memory.task) delete creep.memory.task;
        }
        return null;
    }

    if (st.targetRoom !== targetRoom) {
        st.targetRoom = targetRoom;
        st.arrivalTime = null;
        st._scoutMarked = false;
    }

    if (creep.room.name !== targetRoom) {
        creep.memory.task = {
            action: 'move',
            targetPos: { x: 25, y: 25, roomName: targetRoom },
            range: 24
        };
        return null;
    }

    if (!st.arrivalTime) st.arrivalTime = Game.time;

    if (!st._scoutMarked) {
        scoutUtils.recordScoutIntel(sponsorRoom, creep.room, { setLastScout: true });
        st._scoutMarked = true;
    } else {
        scoutUtils.recordScoutIntel(sponsorRoom, creep.room, { setLastScout: false });
    }

    const elapsed = Game.time - st.arrivalTime;
    if (elapsed < holdTime) {
        if (creep.memory.task) delete creep.memory.task;
        return null;
    }

    st.arrivalTime = null;
    st._scoutMarked = false;
    if (creep.memory.task) delete creep.memory.task;

    return null;
};
