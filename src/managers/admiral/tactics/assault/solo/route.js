function getRouteTarget(creep, runtime, flags, ao) {
    const phase = runtime.phase;
    if (phase === 'RENDEZVOUS') {
        return flags.waitPos || ao.centerPos;
    }

    if (phase === 'STAGE') {
        const waypoints = flags.waypointPositions || [];
        const index = Math.max(0, Number(runtime.waypointIndex) || 0);
        if (waypoints[index]) return waypoints[index];
        if (flags.assemblyPos) return flags.assemblyPos;
        return ao.centerPos || flags.waitPos;
    }

    if (phase === 'ENGAGE') {
        return flags.attackPos || ao.centerPos;
    }

    if (phase === 'RETREAT') {
        return flags.waitPos || ao.centerPos;
    }

    return flags.waitPos || ao.centerPos;
}

module.exports = {
    getRouteTarget
};
