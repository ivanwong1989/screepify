const shared = require('console_shared');

/**
 * Move 2 Flag Mission (M)
 *
 * Flags:
 *  - M   (mission anchor / final target)
 *  - M1, M2, M3... (optional waypoints, followed in numeric order)
 *
 * Purpose:
 *  - Spawn exactly 1 creep with [MOVE]
 *  - Provide waypoint list in mission.data so tasker can follow
 */

const BODY = [MOVE];
const BODY_MODE = 'fixed';
const PRIORITY = 50;

function toPos(pos) {
    return pos ? { x: pos.x, y: pos.y, roomName: pos.roomName } : null;
}

function collectWaypoints() {
    // Collect M1, M2, M3... flags, sort by number ascending
    const items = [];

    for (const key in Game.flags) {
        if (!Object.prototype.hasOwnProperty.call(Game.flags, key)) continue;

        const f = Game.flags[key];
        if (!f || !f.name || !f.pos) continue;

        const m = /^M(\d+)$/.exec(f.name);
        if (!m) continue;

        const n = Number(m[1]);
        if (!Number.isFinite(n)) continue;

        items.push({ n, pos: toPos(f.pos), name: f.name });
    }

    items.sort((a, b) => a.n - b.n);

    // Mission data wants a clean list of positions (and optional names)
    return {
        waypointNames: items.map(i => i.name),
        waypoints: items.map(i => i.pos)
    };
}

module.exports = {
    generate(room, intel, context, missions) {
        if (!room || !room.name) return;
        if (!context || !missions) return;

        const { budget, getMissionCensus } = context;

        // ONLY detect exact flag name "M"
        const flag = Game.flags.M;
        if (!flag || !flag.pos) return;

        // Resolve sponsor room for this target position
        const sponsorRoom = shared.resolveSponsorRoomForTargetPos(flag.pos);
        if (sponsorRoom !== room.name) return;

        const cost = BODY.reduce((sum, part) => sum + BODYPART_COST[part], 0);
        const spawnAllowed = !Number.isFinite(budget) ? true : budget >= cost;

        const missionName = 'move2flag:M';

        const census = (typeof getMissionCensus === 'function')
            ? getMissionCensus(missionName)
            : { count: 0 };

        const wp = collectWaypoints();

        missions.push({
            name: missionName,
            type: 'move2flag',
            archetype: 'move2flag',
            priority: PRIORITY,
            requirements: {
                archetype: 'move2flag',
                count: 1,
                body: BODY,
                bodyMode: BODY_MODE,
                spawn: spawnAllowed
            },
            data: {
                sponsorRoom: room.name,
                flagName: 'M',

                // Final target
                targetPos: toPos(flag.pos),

                // Waypoints for tasker (M1, M2, M3... sorted)
                waypointNames: wp.waypointNames,
                waypoints: wp.waypoints
            },
            census
        });
    }
};