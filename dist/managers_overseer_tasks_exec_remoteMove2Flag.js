const helpers = require('managers_overseer_tasks_exec__helpers');

module.exports = function execRemoteMove2FlagTask(ctx) {
    const { creep, mission } = ctx;
    const data = (mission && mission.data) || {};

    // Waypoints: array of serialized pos objects: [{x,y,roomName}, ...]
    const waypoints = Array.isArray(data.waypoints) ? data.waypoints : [];
    const finalPos = helpers.toRoomPosition(data.targetPos);

    // Minimal persistent state: which waypoint index we are heading to
    if (!Number.isFinite(creep.memory._m2fWp)) creep.memory._m2fWp = 0;

    // If no final target, nothing to do
    if (!finalPos) return null;

    // Optional: allow waypoint range tuning (default 1 so we don't require standing exactly on waypoints)
    const waypointRange = Number.isFinite(data.waypointRange) ? data.waypointRange : 1;

    // Advance through waypoints if already reached (can skip multiple in one tick if stacked)
    while (creep.memory._m2fWp < waypoints.length) {
        const wpPos = helpers.toRoomPosition(waypoints[creep.memory._m2fWp]);
        if (!wpPos) {
            creep.memory._m2fWp += 1;
            continue;
        }

        // If already within range of waypoint, advance to next
        if (creep.pos.inRangeTo(wpPos, waypointRange)) {
            creep.memory._m2fWp += 1;
            continue;
        }

        // Move to current waypoint
        return {
            type: 'move',
            targetPos: { x: wpPos.x, y: wpPos.y, roomName: wpPos.roomName },
            range: waypointRange
        };
    }

    // All waypoints done -> move onto final M (range 0 = stand exactly on it)
    if (!creep.pos.isEqualTo(finalPos)) {
        return {
            type: 'move',
            targetPos: { x: finalPos.x, y: finalPos.y, roomName: finalPos.roomName },
            range: 0
        };
    }

    // Arrived on M
    return null;
};