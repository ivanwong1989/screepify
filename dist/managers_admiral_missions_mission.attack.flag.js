const shared = require('console_shared');

/**
 * Assault Flag Mission (W/A)
 *
 * Flags (multiple sets supported):
 * - W: wait/sponsor flag (required). Determines sponsor room and staging position.
 * - W1, W2, ...: optional waypoint flags (numeric suffix). Assault will traverse these in order before A.
 * - A: attack flag (optional). Determines target room and attack position.
 * - AM: ranged-mass attack flag (optional). Uses ranged mass attack vs structures.
 * - Y: wait/sponsor flag (required). Determines sponsor room and staging position.
 * - Y1, Y2, ...: optional waypoint flags (numeric suffix). Assault will traverse these in order before B.
 * - B: attack flag (optional). Determines target room and attack position.
 * - BM: ranged-mass attack flag (optional). Uses ranged mass attack vs structures.
 *
 * Spawn modes:
 * - Solo (default): one assault mission with body from Memory.military.attack.body.
 * - Duo (leader + support): enabled when Memory.military.attack.supportBody is set.
 *
 * Body config (Memory.military.attack):
 * - body: solo pattern, and fallback for leader if leaderBody is unset.
 * - leaderBody: explicit leader pattern for duo mode.
 * - supportBody: support pattern for duo mode (set to enable duo; clear to disable).
 * - bodyMode: 'auto' (repeat to capacity) or 'fixed' (exact body).
 * - leaderBodyMode: override for leader pattern.
 * - supportBodyMode: override for support pattern.
 *
 * Console helpers:
 * - attackBody(), attackBodyLeader(), attackBodySupport()
 *
 * Mission data (consumed by assault tactics):
 * - assaultRole: 'leader' | 'support' | 'solo'
 * - squadKey: shared key so leader/support coordinate
 * - waitFlagName, attackFlagName, waitPos, attackPos, targetRoom, sponsorRoom
 */

const FLAG_SETS = [
    { wait: 'W', attack: 'A', attackMass: 'AM' },
    { wait: 'Y', attack: 'B', attackMass: 'BM' }
];
const DEFAULT_ATTACK_BODY = [RANGED_ATTACK, MOVE, HEAL];
const DEFAULT_SUPPORT_BODY = [HEAL, MOVE, MOVE];
const DEFAULT_BODY_MODE = 'auto';

function getAssaultSquadMemory() {
    if (!Memory) return null;
    if (!Memory.military) Memory.military = {};
    if (!Memory.military.assaultSquads) Memory.military.assaultSquads = {};
    return Memory.military.assaultSquads;
}

function getLiveAssaultSquadCreeps(squadKey) {
    if (!squadKey) return [];
    return Object.values(Game.creeps).filter(c =>
        c && c.my && c.memory && c.memory.assaultSquad === squadKey
    );
}

function refreshAssaultSquadState(squadKey, liveSquad) {
    const squads = getAssaultSquadMemory();
    if (!squads) return null;
    const state = squads[squadKey];
    if (state && (!liveSquad || liveSquad.length === 0)) {
        delete squads[squadKey];
        return null;
    }
    if (state) {
        state.lastSeen = Game.time;
        state.liveCount = liveSquad.length;
    }
    return state || null;
}

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

function getAttackBodyConfig() {
    const memory = Memory.military && Memory.military.attack ? Memory.military.attack : {};
    const stored = Array.isArray(memory.body) ? memory.body : null;
    const storedLeader = Array.isArray(memory.leaderBody) ? memory.leaderBody : null;
    const storedSupport = Array.isArray(memory.supportBody) ? memory.supportBody : null;

    const leader = normalizeBodyPattern(storedLeader || stored);
    const support = normalizeBodyPattern(storedSupport);
    const solo = normalizeBodyPattern(stored);
    const leaderMode = normalizeBodyMode(storedLeader ? memory.leaderBodyMode : memory.bodyMode);
    const supportMode = normalizeBodyMode(memory.supportBodyMode);
    const soloMode = normalizeBodyMode(memory.bodyMode);

    return {
        leader: leader.length > 0 ? leader : DEFAULT_ATTACK_BODY,
        support: support.length > 0 ? support : null,
        solo: solo.length > 0 ? solo : DEFAULT_ATTACK_BODY,
        modes: {
            leader: leaderMode,
            support: supportMode,
            solo: soloMode
        }
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

function buildFlagAttackCache() {
    const cache = global._flagAttackMissionCache;
    if (cache && cache.time === Game.time) return cache;

    const bySponsorRoom = {};
    for (const set of FLAG_SETS) {
        const waitFlag = Game.flags[set.wait];
        if (!waitFlag) continue;

        const sponsorRoom = shared.resolveSponsorRoomForTargetPos(waitFlag.pos);
        if (!sponsorRoom) continue;

        const attackFlag = Game.flags[set.attackMass] || Game.flags[set.attack];
        const assaultMode = attackFlag && attackFlag.name === set.attackMass
            ? 'rangedMass'
            : undefined;

        const entry = {
            sponsorRoom,
            waitFlagName: waitFlag.name,
            attackFlagName: attackFlag ? attackFlag.name : set.attack,
            waitPos: toPos(waitFlag.pos),
            attackPos: attackFlag ? toPos(attackFlag.pos) : null,
            targetRoom: attackFlag ? attackFlag.pos.roomName : waitFlag.pos.roomName,
            assaultMode
        };

        if (!bySponsorRoom[sponsorRoom]) bySponsorRoom[sponsorRoom] = [];
        bySponsorRoom[sponsorRoom].push(entry);
    }

    const result = { time: Game.time, bySponsorRoom };
    global._flagAttackMissionCache = result;
    return result;
}

module.exports = {
    generate: function(room, intel, context, missions) {
        const cache = buildFlagAttackCache();
        const entries = cache.bySponsorRoom[room.name];
        if (!entries || entries.length === 0) return;

        const { budget, getMissionCensus } = context || {};
        const bodyConfig = getAttackBodyConfig();

        for (const entry of entries) {
            const squadKey = `assault:flag:${entry.waitFlagName}`;
            const useDuo = Array.isArray(bodyConfig.support) && bodyConfig.support.length > 0;
            const liveSquad = getLiveAssaultSquadCreeps(squadKey);
            const squadState = refreshAssaultSquadState(squadKey, liveSquad);
            const lockActive = !!(squadState && squadState.started && liveSquad.length > 0);
            const lockData = lockActive ? {
                active: true,
                startedAt: squadState.startedAt,
                liveCount: liveSquad.length
            } : { active: false };

            if (useDuo) {
                const leaderMission = `${squadKey}:leader`;
                const supportMission = `${squadKey}:support`;
                const leaderCost = getBodyCost(bodyConfig.leader);
                const supportCost = getBodyCost(bodyConfig.support);
                let leaderSpawn = !leaderCost || (Number.isFinite(budget) && budget >= leaderCost);
                let supportSpawn = !supportCost || (Number.isFinite(budget) && budget >= supportCost);
                if (lockActive) {
                    leaderSpawn = false;
                    supportSpawn = false;
                }

                const leaderCensus = typeof getMissionCensus === 'function'
                    ? getMissionCensus(leaderMission)
                    : { count: 0, workParts: 0, carryParts: 0 };
                const supportCensus = typeof getMissionCensus === 'function'
                    ? getMissionCensus(supportMission)
                    : { count: 0, workParts: 0, carryParts: 0 };

                debug('mission.attack.flag', `[AssaultFlag] ${room.name} wait=${entry.waitPos.roomName} attack=${entry.targetRoom} leaderSpawn=${leaderSpawn} supportSpawn=${supportSpawn}`);

                missions.push({
                    name: leaderMission,
                    type: 'assault',
                    archetype: 'assault',
                    priority: 90,
                    requirements: {
                        archetype: 'assault',
                        count: 1,
                        body: bodyConfig.leader,
                        bodyMode: bodyConfig.modes.leader,
                        spawn: leaderSpawn
                    },
                    data: {
                        waitFlagName: entry.waitFlagName,
                        attackFlagName: entry.attackFlagName,
                        waitPos: entry.waitPos,
                        attackPos: entry.attackPos,
                        targetRoom: entry.targetRoom,
                        sponsorRoom: room.name,
                        assaultRole: 'leader',
                        squadKey,
                        closeRangeStructures: true,
                        assaultLock: lockData,
                        assaultMode: entry.assaultMode
                    },
                    census: leaderCensus
                });

                missions.push({
                    name: supportMission,
                    type: 'assault',
                    archetype: 'assault',
                    priority: 90,
                    requirements: {
                        archetype: 'assault',
                        count: 1,
                        body: bodyConfig.support,
                        bodyMode: bodyConfig.modes.support,
                        spawn: supportSpawn
                    },
                    data: {
                        waitFlagName: entry.waitFlagName,
                        attackFlagName: entry.attackFlagName,
                        waitPos: entry.waitPos,
                        attackPos: entry.attackPos,
                        targetRoom: entry.targetRoom,
                        sponsorRoom: room.name,
                        assaultRole: 'support',
                        squadKey,
                        closeRangeStructures: true,
                        assaultLock: lockData,
                        assaultMode: entry.assaultMode
                    },
                    census: supportCensus
                });
            } else {
                const missionName = squadKey;
                const patternCost = getBodyCost(bodyConfig.solo);
                const spawnAllowed = !patternCost || (Number.isFinite(budget) && budget >= patternCost);
                const census = typeof getMissionCensus === 'function'
                    ? getMissionCensus(missionName)
                    : { count: 0, workParts: 0, carryParts: 0 };

                debug('mission.attack.flag', `[AssaultFlag] ${room.name} wait=${entry.waitPos.roomName} attack=${entry.targetRoom} spawn=${spawnAllowed}`);

                missions.push({
                    name: missionName,
                    type: 'assault',
                    archetype: 'assault',
                    priority: 90,
                    requirements: {
                        archetype: 'assault',
                        count: 1,
                        body: bodyConfig.solo,
                        bodyMode: bodyConfig.modes.solo,
                        spawn: spawnAllowed
                    },
                    data: {
                        waitFlagName: entry.waitFlagName,
                        attackFlagName: entry.attackFlagName,
                        waitPos: entry.waitPos,
                        attackPos: entry.attackPos,
                        targetRoom: entry.targetRoom,
                        sponsorRoom: room.name,
                        assaultRole: 'solo',
                        squadKey,
                        closeRangeStructures: true,
                        assaultMode: entry.assaultMode
                    },
                    census: census
                });
            }
        }
    }
};
