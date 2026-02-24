const shared = require('console_shared');
const userMissions = require('userMissions');

/**
 * Move 2 Flag Mission (User)
 *
 * Flags:
 *  - <flagName>   (mission anchor / final target)
 *  - <flagName>1, <flagName>2, <flagName>3... (optional waypoints, followed in numeric order)
 *
 * Purpose:
 *  - Spawn exactly 1 creep with [MOVE]
 *  - Provide waypoint list in mission.data so tasker can follow
 *  - User mission entries control which flags are active
 */

const BODY = [MOVE];
const BODY_MODE = 'fixed';
const PRIORITY = 50;
const CREEP_SPAWNING_FREQUENCY_TICKS = 1500;

function getMove2FlagTimerStore(room) {
    if (!room.memory.overseer) room.memory.overseer = {};
    if (!room.memory.overseer.move2flag) room.memory.overseer.move2flag = {};
    if (!room.memory.overseer.move2flag.timers) room.memory.overseer.move2flag.timers = {};
    return room.memory.overseer.move2flag.timers;
}

function getContractId(roomName, missionName) {
    return `home=${roomName}|role=move2flag|bind=mission:${missionName}`;
}

function hasActiveTicket(room, contractId) {
    const index = Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].spawnTicketsByKey
        ? Memory.rooms[room.name].spawnTicketsByKey
        : null;
    const list = index ? index[contractId] : null;
    if (!list || list.length === 0) return false;

    const tickets = Memory.spawnTickets || {};
    for (const id of list) {
        const ticket = tickets[id];
        if (!ticket) continue;
        if (ticket.expiresAt && ticket.expiresAt <= Game.time) continue;
        if (!['REQUESTED', 'SPAWNING', 'EN_ROUTE', 'ACTIVE'].includes(ticket.state)) continue;
        return true;
    }
    return false;
}

function toPos(pos) {
    return pos ? { x: pos.x, y: pos.y, roomName: pos.roomName } : null;
}

function escapeRegExp(value) {
    return ('' + value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectWaypoints(flagName) {
    // Collect <flagName>1, <flagName>2, <flagName>3... flags, sort by number ascending
    const name = flagName || 'M';
    const rx = new RegExp(`^${escapeRegExp(name)}(\\d+)$`);
    const items = [];

    for (const key in Game.flags) {
        if (!Object.prototype.hasOwnProperty.call(Game.flags, key)) continue;

        const f = Game.flags[key];
        if (!f || !f.name || !f.pos) continue;

        const m = rx.exec(f.name);
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

        const missionItems = userMissions.getByType('move2flag');
        if (!missionItems || missionItems.length === 0) return;

        const cost = BODY.reduce((sum, part) => sum + BODYPART_COST[part], 0);
        const canAfford = !Number.isFinite(budget) ? true : (budget >= cost);
        const timerStore = getMove2FlagTimerStore(room);
        const activeIds = new Set(missionItems.map(m => m && m.id).filter(Boolean));

        for (const id of Object.keys(timerStore)) {
            if (!activeIds.has(id)) delete timerStore[id];
        }

        for (const mission of missionItems) {
            if (!mission || mission.enabled === false) continue;

            const flagName = (mission.flagName || 'M').trim();
            if (!flagName) continue;

            const flag = Game.flags[flagName];
            if (!flag || !flag.pos) {
                if (mission.persist !== true) {
                    userMissions.removeMission(mission.id);
                }
                continue;
            }

            // Resolve sponsor room for this target position
            let sponsorRoom = mission.sponsorRoom;
            if (!sponsorRoom) {
                sponsorRoom = shared.resolveSponsorRoomForTargetPos(flag.pos);
                if (sponsorRoom) userMissions.updateMission(mission.id, { sponsorRoom });
            }
            if (sponsorRoom !== room.name) continue;

            const nameSuffix = mission.label ? `${mission.id}:${mission.label}` : mission.id;
            const missionName = `move2flag:${nameSuffix}`;

            const census = (typeof getMissionCensus === 'function')
                ? getMissionCensus(missionName)
                : { count: 0 };

            const wp = collectWaypoints(flagName);
            const contractId = getContractId(room.name, missionName);
            const timer = timerStore[mission.id] || {};

            if (hasActiveTicket(room, contractId)) {
                if (!Number.isFinite(timer.lastSpawnedAt)
                    || Game.time - timer.lastSpawnedAt > CREEP_SPAWNING_FREQUENCY_TICKS) {
                    timer.lastSpawnedAt = Game.time;
                }
            }

            timerStore[mission.id] = timer;
            const lastSpawnedAt = timer.lastSpawnedAt;
            const gateOpen = !Number.isFinite(lastSpawnedAt)
                ? true
                : (Game.time - lastSpawnedAt >= CREEP_SPAWNING_FREQUENCY_TICKS);
            const spawnAllowed = canAfford && gateOpen;

            missions.push({
                name: missionName,
                type: 'move2flag',
                archetype: 'move2flag',
                priority: Number.isFinite(mission.priority) ? mission.priority : PRIORITY,
                requirements: {
                    archetype: 'move2flag',
                    count: 1,
                    body: BODY,
                    bodyMode: BODY_MODE,
                    spawn: spawnAllowed
                },
                data: {
                    userMissionId: mission.id,
                    sponsorRoom: room.name,
                    flagName: flagName,

                    // Final target
                    targetPos: toPos(flag.pos),

                    // Waypoints for tasker (<flagName>1, <flagName>2, <flagName>3... sorted)
                    waypointNames: wp.waypointNames,
                    waypoints: wp.waypoints
                },
                census
            });
        }
    }
};
