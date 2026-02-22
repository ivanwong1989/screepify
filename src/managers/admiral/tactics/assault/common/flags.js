function toPlainPos(pos) {
    if (!pos) return null;
    return { x: pos.x, y: pos.y, roomName: pos.roomName };
}

function getFlagPos(flagName) {
    if (!flagName) return null;
    const flag = Game.flags && Game.flags[flagName];
    if (!flag) return null;
    return toPlainPos(flag.pos);
}

function buildFallbackPos(roomName) {
    if (!roomName) return null;
    return { x: 25, y: 25, roomName };
}

function getOwnerAnchorPos(roomName) {
    if (!roomName) return null;
    const room = Game.rooms && Game.rooms[roomName];
    if (!room) return null;
    const spawns = room.find(FIND_MY_SPAWNS);
    if (spawns && spawns.length > 0) {
        spawns.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        return toPlainPos(spawns[0].pos);
    }
    if (room.controller) return toPlainPos(room.controller.pos);
    return null;
}

function resolveFlags(mission) {
    const data = (mission && mission.data) || {};
    const flags = data.flags || {};

    const waitFlagPos = getFlagPos(flags.wait);
    const attackPos = getFlagPos(flags.attack);
    const assemblyFlagPos = getFlagPos(flags.assembly);
    const waypointPositions = Array.isArray(flags.waypoints)
        ? flags.waypoints.map(getFlagPos).filter(p => p)
        : [];

    const fallbackRoom = data.ownerRoom || data.sponsorRoom || (data.ao && data.ao.targetRoom);
    const ownerAnchorPos = getOwnerAnchorPos(fallbackRoom);
    const hasAnyFlag = !!(waitFlagPos || attackPos || assemblyFlagPos || waypointPositions.length > 0);
    const safeFallback = ownerAnchorPos || buildFallbackPos(fallbackRoom);

    const waitPos = waitFlagPos || ownerAnchorPos || (!hasAnyFlag ? safeFallback : null);
    const assemblyPos = assemblyFlagPos || waitFlagPos || ownerAnchorPos || safeFallback;

    return {
        waitPos,
        attackPos: attackPos || null,
        assemblyPos: assemblyPos || null,
        waypointPositions,
        anchorPos: ownerAnchorPos || null
    };
}

module.exports = {
    resolveFlags
};
