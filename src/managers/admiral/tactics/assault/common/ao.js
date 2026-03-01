function resolveAO(mission, flags) {
    const data = mission && mission.data ? mission.data : {};

    // ---- targetRoom ----
    const targetRoom =
        (flags && flags.attackPos && flags.attackPos.roomName) ||
        (data.ao && data.ao.targetRoom) ||
        undefined;

    // ---- centerPos ----
    const centerPos =
        (flags && flags.attackPos) ||
        (data.ao && data.ao.centerPos) ||
        (flags && flags.waitPos) ||
        undefined;

    // ---- radius ----
    let radius = 0;

    // 1) explicit mission config
    const rawMissionRadius =
        data && data.ao && Number.isFinite(data.ao.radius)
            ? data.ao.radius
            : undefined;

    if (Number.isFinite(rawMissionRadius) && rawMissionRadius > 0) {
        radius = rawMissionRadius;
    }
    // 2) flag name override (A10 / D3 etc)
    else if (
        flags &&
        Number.isFinite(flags.attackAoRadiusOverride) &&
        flags.attackAoRadiusOverride > 0
    ) {
        radius = flags.attackAoRadiusOverride;
    }

    // Clamp 0..25
    radius = Math.max(0, Math.min(25, Math.floor(radius)));

    return {
        targetRoom,
        centerPos,
        radius
    };
}

module.exports = {
    resolveAO
};

module.exports = { resolveAO };