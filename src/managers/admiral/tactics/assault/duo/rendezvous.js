function inRange(pos, target, range) {
    if (!pos || !target) return false;
    if (pos.roomName !== target.roomName) return false;
    return Math.abs(pos.x - target.x) <= range && Math.abs(pos.y - target.y) <= range;
}

function isTogether(leader, support, range) {
    if (!leader || !support) return false;
    if (leader.room.name !== support.room.name) return false;
    return leader.pos.getRangeTo(support.pos) <= range;
}

function shouldRendezvous(leader, support) {
    if (!leader || !support) return true;
    if (leader.room.name !== support.room.name) return true;
    return leader.pos.getRangeTo(support.pos) > 1;
}

function hasArrived(pos, waitPos) {
    if (!pos || !waitPos) return false;
    return inRange(pos, waitPos, 1);
}

module.exports = {
    isTogether,
    shouldRendezvous,
    hasArrived,
    isAssembled: function(leader, support, assemblyPos) {
        if (!leader || !support || !assemblyPos) return false;

        if (leader.room.name !== assemblyPos.roomName) return false;
        if (support.room.name !== assemblyPos.roomName) return false;

        // allow duo to "arrive" if both are within 2 of flag
        if (!leader.pos.inRangeTo(assemblyPos.x, assemblyPos.y, 2)) return false;
        if (!support.pos.inRangeTo(assemblyPos.x, assemblyPos.y, 2)) return false;

        // still require tight cohesion
        return leader.pos.getRangeTo(support.pos) <= 1;
    }
};
