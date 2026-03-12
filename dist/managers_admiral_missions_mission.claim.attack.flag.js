const shared = require('console_shared');

const CLAIM_FLAG = 'C';
const CLAIM_ASSEMBLY_FLAG = 'C0';
const DEFAULT_CLAIMER_BODY = [CLAIM, MOVE];

function toPos(pos) {
    if (!pos) return null;
    return { x: pos.x, y: pos.y, roomName: pos.roomName };
}

function getWaypointFlagNames(prefix) {
    const result = [];
    for (const name in Game.flags) {
        if (!Object.prototype.hasOwnProperty.call(Game.flags, name)) continue;
        if (!name.startsWith(prefix)) continue;
        const suffix = name.slice(prefix.length);
        if (!/^\d+$/.test(suffix)) continue;
        const order = Number(suffix);
        // C0 is reserved as claim mission assembly/sponsor flag.
        if (!Number.isFinite(order) || order <= 0) continue;
        result.push({ name, order });
    }
    result.sort((a, b) => a.order - b.order);
    return result.map(e => e.name);
}

function buildClaimAttackCache() {
    const cache = global._claimAttackFlagMissionCache;
    if (cache && cache.time === Game.time) return cache;

    const bySponsorRoom = {};
    const claimFlag = Game.flags[CLAIM_FLAG];
    if (!claimFlag) {
        const empty = { time: Game.time, bySponsorRoom };
        global._claimAttackFlagMissionCache = empty;
        return empty;
    }

    // Use C0 as explicit origin/sponsor anchor when present.
    // Fallback to C so older setups continue to work.
    const assemblyFlag = Game.flags[CLAIM_ASSEMBLY_FLAG] || null;
    const sponsorAnchorPos = assemblyFlag ? assemblyFlag.pos : claimFlag.pos;
    const sponsorRoom = shared.resolveSponsorRoomForTargetPos(sponsorAnchorPos);
    if (!sponsorRoom) {
        const empty = { time: Game.time, bySponsorRoom };
        global._claimAttackFlagMissionCache = empty;
        return empty;
    }

    const waypointFlagNames = getWaypointFlagNames(CLAIM_FLAG);
    const claimPos = toPos(claimFlag.pos);

    bySponsorRoom[sponsorRoom] = [{
        sponsorRoom,
        claimFlagName: claimFlag.name,
        assemblyFlagName: assemblyFlag ? assemblyFlag.name : null,
        assemblyPos: assemblyFlag ? toPos(assemblyFlag.pos) : null,
        claimPos,
        targetRoom: claimFlag.pos.roomName,
        waypointFlagNames
    }];

    const result = { time: Game.time, bySponsorRoom };
    global._claimAttackFlagMissionCache = result;
    return result;
}

module.exports = {
    generate: function(room, intel, context, missions) {
        const cache = buildClaimAttackCache();
        const entries = cache.bySponsorRoom[room.name];
        if (!entries || entries.length === 0) return;

        const { budget, getMissionCensus } = context || {};

        for (const entry of entries) {
            const missionName = `assault:claim:${entry.claimFlagName}`;
            const census = typeof getMissionCensus === 'function'
                ? getMissionCensus(missionName)
                : { count: 0, workParts: 0, carryParts: 0 };
            const targetRoom = Game.rooms[entry.targetRoom];
            const targetController = targetRoom && targetRoom.controller ? targetRoom.controller : null;
            const alreadyMine = !!(targetController && targetController.my);
            const spawnAllowed = !alreadyMine && Number.isFinite(budget) && budget >= 650;

            missions.push({
                name: missionName,
                type: 'assault',
                archetype: 'claimer',
                priority: 95,
                requirements: {
                    archetype: 'claimer',
                    minCount: 1,
                    maxCount: 1,
                    body: DEFAULT_CLAIMER_BODY,
                    bodyMode: 'fixed',
                    spawn: spawnAllowed
                },
                data: {
                    ownerRoom: room.name,
                    sponsorRoom: room.name,
                    targetRoom: entry.targetRoom,
                    assaultMode: 'claimAttack',
                    assemblyFlagName: entry.assemblyFlagName,
                    assemblyPos: entry.assemblyPos,
                    claimFlagName: entry.claimFlagName,
                    claimPos: entry.claimPos,
                    waypointFlagNames: entry.waypointFlagNames || []
                },
                census
            });
        }
    }
};
