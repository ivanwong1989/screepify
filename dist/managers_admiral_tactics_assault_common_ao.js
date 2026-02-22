function resolveAO(mission, flags) {
    const data = (mission && mission.data) || {};
    const ao = data.ao || {};
    const targetRoom = ao.targetRoom
        || (flags.attackPos && flags.attackPos.roomName)
        || (flags.waitPos && flags.waitPos.roomName)
        || data.ownerRoom
        || null;

    const centerPos = ao.centerPos
        || flags.attackPos
        || flags.assemblyPos
        || flags.waitPos
        || (targetRoom ? { x: 25, y: 25, roomName: targetRoom } : null);

    const radius = Number.isFinite(ao.radius) ? ao.radius : 0;

    return {
        targetRoom,
        centerPos,
        radius
    };
}

module.exports = {
    resolveAO
};
