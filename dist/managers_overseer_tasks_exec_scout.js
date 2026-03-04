const scoutUtils = require('managers_overseer_utils_overseer.scout');

module.exports = function execScoutTask(ctx) {
    const { creep, mission, room } = ctx;
    const data = mission.data || {};
    const log = (msg) => debug('mission.scout', `[ScoutTask] ${creep.name} ${msg}`);

    const sponsorRoom = data.sponsorRoom || (room && room.name) || (creep.memory && creep.memory.room) || creep.room.name;
    const rooms = Array.isArray(data.rooms) ? data.rooms : [];
    const interval = Number.isFinite(data.interval) ? data.interval : 500;
    const holdTime = Number.isFinite(data.holdTime) ? data.holdTime : 10;
    const targetRoom = data.targetRoom || null;

    // Keep scout mission metadata on creep (fine to keep)
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

    // No due target -> idle at sponsor
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

        // In sponsor + no target => no task
        return null;
    }

    // Retarget
    if (st.targetRoom !== targetRoom) {
        st.targetRoom = targetRoom;
        st.arrivalTime = null;
        st._scoutMarked = false;
        logOnce(`retarget:${targetRoom}`, `target=${targetRoom} sponsor=${sponsorRoom}`);
    }

    // Travel to target room
    if (creep.room.name !== targetRoom) {
        return {
            type: 'move',
            targetPos: { x: 25, y: 25, roomName: targetRoom },
            range: 24
        };
    }

    // Arrived: start hold timer + record intel
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

    // Hold in-room (no move task while holding)
    const elapsed = Game.time - st.arrivalTime;
    if (elapsed < holdTime) return null;

    // Done holding => next tick mission generator should pick next due room
    st.arrivalTime = null;
    st._scoutMarked = false;
    logOnce(`complete:${targetRoom}:${Game.time}`, `complete room=${targetRoom} elapsed=${elapsed}`);

    return null;
};