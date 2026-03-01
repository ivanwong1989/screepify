function resolveAO(mission, flags) {
    const data = (mission && mission.data) || {};
    const ao = data.ao || {};

    // If we currently resolve an attack flag position (supports A12/B6 prefix matching),
    // it must win. mission.data.ao.targetRoom can be stale.
    const targetRoom = (flags.attackPos && flags.attackPos.roomName)
        || ao.targetRoom
        || (flags.waitPos && flags.waitPos.roomName)
        || data.ownerRoom
        || null;
    // Same issue: mission.data.ao.centerPos may have been initialized when only "A" existed,
    // and becomes stale when using "A3"/"A12". If we have an attackPos, it must win.
    const centerPos = flags.attackPos
        || ao.centerPos
         || flags.assemblyPos
         || flags.waitPos
         || (targetRoom ? { x: 25, y: 25, roomName: targetRoom } : null);

    // 1) Flag NAME override: A12/B6/etc (from flags.js)
    const rawNameOverride = flags ? flags.attackAoRadiusOverride : undefined;
    const nameOverrideNum = Number(rawNameOverride);
    const nameOverride = Number.isFinite(nameOverrideNum) ? nameOverrideNum : undefined;

    // 2) Flag memory fallback (your old console-edit path)
    const rawFlagRadius =
        flags && flags.attackFlag && flags.attackFlag.memory
            ? flags.attackFlag.memory.aoRadius
            : undefined;

    const flagRadiusNum = Number(rawFlagRadius);
    const flagRadius = Number.isFinite(flagRadiusNum) ? flagRadiusNum : undefined;

    const aoRadiusNum = Number(ao.radius);
    const hasExplicitAoRadius = Number.isFinite(aoRadiusNum) && aoRadiusNum > 0; // 0 means "unset"

    let radius = hasExplicitAoRadius
        ? aoRadiusNum
        : (Number.isFinite(nameOverride) ? nameOverride
            : (Number.isFinite(flagRadius) ? flagRadius : 0));

    radius = Math.max(0, Math.min(25, Math.floor(radius)));

    return {
        targetRoom,
        centerPos,
        radius
    };
}

module.exports = { resolveAO };