const shared = require('console_shared');

/**
 * Assault Dismantle Flag Mission (D/A)
 *
 * Flags:
 * - D: wait/sponsor flag (required). Determines sponsor room and staging position.
 * - W1, W2, ...: optional waypoint flags (numeric suffix). Uses W as the waypoint base.
 * - A: attack flag (optional). Determines target room and attack position.
 *
 * Mission data (consumed by assault tactics):
 * - assaultMode: 'dismantle'
 * - assaultRole: 'solo'
 * - squadKey: shared key so any support stays coordinated
 * - waitFlagName, waypointFlagName, attackFlagName, waitPos, attackPos, targetRoom, sponsorRoom
 */

const FLAG_WAIT = 'D';
const FLAG_ATTACK = 'A';
const FLAG_WAYPOINT = 'W';
const DEFAULT_DISMANTLE_BODY = [WORK, MOVE];
const DEFAULT_BODY_MODE = 'auto';

function normalizeBodyPart(part) {
    if (part === undefined || part === null) return null;
    if (typeof part === 'string') {
        const raw = part.trim();
        if (raw && BODYPART_COST && BODYPART_COST[raw]) return raw;
        const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_');
        if (normalized && BODYPART_COST && BODYPART_COST[normalized]) return normalized;
    }
    return null;
}

function normalizeBodyPattern(parts) {
    if (!Array.isArray(parts)) return [];
    return parts.map(normalizeBodyPart).filter(p => p);
}

function normalizeBodyMode(mode) {
    if (mode === 'fixed') return 'fixed';
    return DEFAULT_BODY_MODE;
}

function getDismantleBodyConfig() {
    const memory = Memory.military && Memory.military.dismantle ? Memory.military.dismantle : {};
    const stored = Array.isArray(memory.body) ? memory.body : null;
    const pattern = normalizeBodyPattern(stored || DEFAULT_DISMANTLE_BODY);
    const mode = normalizeBodyMode(memory.bodyMode);
    return {
        body: pattern.length > 0 ? pattern : DEFAULT_DISMANTLE_BODY,
        mode
    };
}

function getBodyCost(pattern) {
    if (!Array.isArray(pattern)) return 0;
    return pattern.reduce((sum, part) => sum + (BODYPART_COST[part] || 0), 0);
}

function toPos(pos) {
    if (!pos) return null;
    return { x: pos.x, y: pos.y, roomName: pos.roomName };
}

function buildFlagDismantleCache() {
    const cache = global._flagDismantleMissionCache;
    if (cache && cache.time === Game.time) return cache;

    const waitFlag = Game.flags[FLAG_WAIT];
    if (!waitFlag) {
        const empty = { time: Game.time, bySponsorRoom: {} };
        global._flagDismantleMissionCache = empty;
        return empty;
    }

    const sponsorRoom = shared.resolveSponsorRoomForTargetPos(waitFlag.pos);
    if (!sponsorRoom) {
        const empty = { time: Game.time, bySponsorRoom: {} };
        global._flagDismantleMissionCache = empty;
        return empty;
    }

    const attackFlag = Game.flags[FLAG_ATTACK];
    const entry = {
        sponsorRoom,
        waitFlagName: waitFlag.name,
        waypointFlagName: FLAG_WAYPOINT,
        attackFlagName: FLAG_ATTACK,
        waitPos: toPos(waitFlag.pos),
        attackPos: attackFlag ? toPos(attackFlag.pos) : null,
        targetRoom: attackFlag ? attackFlag.pos.roomName : waitFlag.pos.roomName
    };

    const bySponsorRoom = {};
    bySponsorRoom[sponsorRoom] = [entry];
    const result = { time: Game.time, bySponsorRoom };
    global._flagDismantleMissionCache = result;
    return result;
}

module.exports = {
    generate: function(room, intel, context, missions) {
        const cache = buildFlagDismantleCache();
        const entries = cache.bySponsorRoom[room.name];
        if (!entries || entries.length === 0) return;

        const { budget, getMissionCensus } = context || {};
        const bodyConfig = getDismantleBodyConfig();

        for (const entry of entries) {
            const squadKey = `assault:dismantle:${entry.waitFlagName}`;
            const patternCost = getBodyCost(bodyConfig.body);
            const spawnAllowed = !patternCost || (Number.isFinite(budget) && budget >= patternCost);
            const census = typeof getMissionCensus === 'function'
                ? getMissionCensus(squadKey)
                : { count: 0, workParts: 0, carryParts: 0 };

            debug('mission.dismantle.flag', `[AssaultDismantleFlag] ${room.name} wait=${entry.waitPos.roomName} attack=${entry.targetRoom} spawn=${spawnAllowed}`);

            missions.push({
                name: squadKey,
                type: 'assault',
                archetype: 'assault',
                priority: 90,
                requirements: {
                    archetype: 'assault',
                    count: 1,
                    body: bodyConfig.body,
                    bodyMode: bodyConfig.mode,
                    spawn: spawnAllowed
                },
                data: {
                    waitFlagName: entry.waitFlagName,
                    waypointFlagName: entry.waypointFlagName,
                    attackFlagName: entry.attackFlagName,
                    waitPos: entry.waitPos,
                    attackPos: entry.attackPos,
                    targetRoom: entry.targetRoom,
                    sponsorRoom: room.name,
                    assaultRole: 'solo',
                    assaultMode: 'dismantle',
                    squadKey
                },
                census
            });
        }
    }
};
