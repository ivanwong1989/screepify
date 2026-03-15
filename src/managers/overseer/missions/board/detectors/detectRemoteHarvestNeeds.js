const remoteUtils = require('managers_overseer_utils_overseer.remote');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');

function run({ room, intel, context, missionBoard }) {
    if (!room || !missionBoard) return;
    if (context && context.opState === 'EMERGENCY') return;
    const live = missionBoard.listLiveByRoom(room.name);
    const liveRemoteHarvest = [];
    for (let i = 0; i < live.length; i++) {
        const mission = live[i];
        if (mission && mission.type === 'remoteHarvest') liveRemoteHarvest.push(mission);
    }
    if (liveRemoteHarvest.length > 0 && !missionThrottle.shouldRunDetector('remoteHarvest', room.name, Game.time)) {
        return;
    }

    const entries = remoteUtils.getRemoteEconomicContext(room, {
        opState: context && context.opState ? context.opState : null,
        maxScoutAge: 4000
    });
    const enabledRooms = new Set(entries.filter(e => e && e.enabled && e.name).map(e => e.name));

    // Hard cleanup: if a room is no longer enabled by remote cap/gates, cancel its missions now.
    for (let i = 0; i < liveRemoteHarvest.length; i++) {
        const mission = liveRemoteHarvest[i];
        if (!mission) continue;
        const remoteRoom = mission.targetRoom || (mission.meta && mission.meta.remoteRoom) || null;
        if (remoteRoom && !enabledRooms.has(remoteRoom)) {
            missionBoard.markCancelled(mission.id, 'remote_room_not_enabled');
        }
    }

    for (let i = 0; i < entries.length; i++) {
        const wrapped = entries[i];
        const remoteRoom = wrapped && wrapped.name ? wrapped.name : null;
        const entry = wrapped && wrapped.entry ? wrapped.entry : null;
        const enabled = !!(wrapped && wrapped.enabled);
        if (!enabled || !remoteRoom || !entry || !Array.isArray(entry.sourcesInfo)) continue;

        for (let j = 0; j < entry.sourcesInfo.length; j++) {
            const source = entry.sourcesInfo[j];
            if (!source || !source.id) continue;
            missionBoard.createMission('remoteHarvest', {
                sponsorRoom: room.name,
                remoteRoom,
                sourceId: source.id,
                sourcePos: { x: source.x, y: source.y, roomName: remoteRoom },
                containerId: source.containerId || null,
                containerPos: source.containerPos || null,
                standPos: source.standPos || null,
                availableSpaces: source.availableSpaces || 1,
                hasContainer: !!(source.hasContainer || source.containerId),
                priority: 80
            }, { room, intel, context });
        }
    }
}

module.exports = {
    type: 'remoteHarvest',
    run
};
