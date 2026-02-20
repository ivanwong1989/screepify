module.exports = function execScoutTask(ctx) {
    const { creep, mission, room } = ctx;
    const data = mission.data || {};
    const sponsorRoom = data.sponsorRoom || room.name;
    const rooms = Array.isArray(data.rooms) ? data.rooms : [];
    const interval = Number.isFinite(data.interval) ? data.interval : 500;

    creep.memory.scout = {
        sponsorRoom,
        rooms,
        interval,
        holdTime: data.holdTime,
        repeat: data.repeat
    };

    return null;
};