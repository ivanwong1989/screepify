const remoteUtils = require('managers_overseer_utils_overseer.remote');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');

function hasDropoffTarget(room, intel) {
    if (!room || !intel) return false;
    const miningContainerIds = new Set((intel.sources || []).map(s => s.containerId).filter(id => !!id));
    const allContainers = intel.structures && intel.structures[STRUCTURE_CONTAINER]
        ? intel.structures[STRUCTURE_CONTAINER]
        : [];
    const nonMiningContainers = allContainers.filter(c => !miningContainerIds.has(c.id));
    return !!(room.storage || nonMiningContainers[0]);
}

function run({ room, intel, context, missionBoard }) {
    if (!room || !intel || !missionBoard) return;
    if (context && context.opState === 'EMERGENCY') return;
    if (!hasDropoffTarget(room, intel)) return;
    const live = missionBoard.listLiveByRoom(room.name);
    const liveRemoteHaul = [];
    for (let i = 0; i < live.length; i++) {
        const mission = live[i];
        if (mission && mission.type === 'remoteHaul') liveRemoteHaul.push(mission);
    }
    if (liveRemoteHaul.length > 0 && !missionThrottle.shouldRunDetector('remoteHaul', room.name, Game.time)) {
        return;
    }

    const entries = remoteUtils.getRemoteEconomicContext(room, {
        opState: context && context.opState ? context.opState : null,
        maxScoutAge: 4000
    });
    const enabledRooms = new Set(entries.filter(e => e && e.enabled && e.name).map(e => e.name));

    // Hard cleanup: if a room is no longer enabled by remote cap/gates, cancel its missions now.
    for (let i = 0; i < liveRemoteHaul.length; i++) {
        const mission = liveRemoteHaul[i];
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
            missionBoard.createMission('remoteHaul', {
                sponsorRoom: room.name,
                remoteRoom,
                sourceId: source.id,
                priority: 70
            }, { room, intel, context });
        }
    }
}

module.exports = {
    type: 'remoteHaul',
    run
};
