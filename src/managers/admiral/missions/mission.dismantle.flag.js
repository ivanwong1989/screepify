const shared = require('console_shared');

/**
 * Assault Dismantle Flag Mission (Z + D AO)
 *
 * Player-facing flags:
 * - Z: assembly / sponsor flag (required). Determines sponsor room and staging position.
 * - Z1, Z2, ...: optional waypoint flags (numeric suffix). Traversed in order before engage.
 * - D / D<number>: AO flag (optional). If numeric suffix exists, it is used as AO radius.
 *   Examples: D (radius 0), D3 (radius 3), D10 (radius 10).
 * - DH: Hard target flag (optional). If present, dismantle will ONLY target structures on this flag tile.
 *   (No AO scanning; it will not dismantle anything else.)
 *
 * NOTE (compat):
 * - We DO NOT use an "A" flag for dismantle.
 * - However, the assault SOLO controller still expects a mission.data.flags.attack flag to exist
 *   to remain in ENGAGE phase.
 * - So we internally set flags.attack to:
 *     - D (if present), else
 *     - Z (fallback)
 *
 * Mission data (consumed by assault tactics):
 * - assaultMode: 'dismantle'
 * - assaultRole: 'solo'
 * - squadKey: shared key for coordination / telemetry
 * - flags: { wait, assembly, attack, waypoints[] }
 * - ao: { targetRoom, radius, centerPos }
 *
 * Legacy convenience fields are also included:
 * - waitFlagName, waypointFlagName, attackFlagName, waitPos, attackPos, targetRoom, sponsorRoom
 */

const FLAG_ASSEMBLY = 'Z';
const FLAG_AO_PREFIX = 'D';
const FLAG_HARD_TARGET = 'DH';

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

function getWaypointFlagNames(prefix) {
    const result = [];
    for (const name in Game.flags) {
        if (!Object.prototype.hasOwnProperty.call(Game.flags, name)) continue;
        if (!name.startsWith(prefix)) continue;
        const suffix = name.slice(prefix.length);
        if (!/^\d+$/.test(suffix)) continue;
        result.push({ name, order: Number(suffix) });
    }
    result.sort((a, b) => a.order - b.order);
    return result.map(e => e.name);
}

function resolveAoFlag(prefix) {
    // Prefer exact "D" if present; otherwise choose the D<number> with the largest number.
    const exact = Game.flags[prefix];
    if (exact) return exact;

    let best = null;
    let bestN = -1;
    for (const name in Game.flags) {
        if (!Object.prototype.hasOwnProperty.call(Game.flags, name)) continue;
        if (!name.startsWith(prefix)) continue;
        const suffix = name.slice(prefix.length);
        if (!/^\d+$/.test(suffix)) continue;
        const n = Number(suffix);
        if (!Number.isFinite(n)) continue;
        if (n > bestN) {
            bestN = n;
            best = Game.flags[name];
        }
    }
    return best;
}

function getAoRadiusFromFlag(flag, prefix) {
    if (!flag || !flag.name) return 0;
    if (flag.name === prefix) return 0;
    const m = flag.name.match(new RegExp(`^${prefix}(\\d+)$`));
    if (!m) return 0;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : 0;
}

function buildFlagDismantleCache() {
    const cache = global._flagDismantleMissionCache;
    if (cache && cache.time === Game.time) return cache;

    const assemblyFlag = Game.flags[FLAG_ASSEMBLY];
    if (!assemblyFlag) {
        const empty = { time: Game.time, bySponsorRoom: {} };
        global._flagDismantleMissionCache = empty;
        return empty;
    }

    const sponsorRoom = shared.resolveSponsorRoomForTargetPos(assemblyFlag.pos);
    if (!sponsorRoom) {
        const empty = { time: Game.time, bySponsorRoom: {} };
        global._flagDismantleMissionCache = empty;
        return empty;
    }

    const aoFlag = resolveAoFlag(FLAG_AO_PREFIX);
    const aoRadius = getAoRadiusFromFlag(aoFlag, FLAG_AO_PREFIX);

    const hardTargetFlag = Game.flags[FLAG_HARD_TARGET] || null;

    const waypointFlagNames = getWaypointFlagNames(FLAG_ASSEMBLY);

    const waitPos = toPos(assemblyFlag.pos);

    // ✅ Compat "attack" flag:
    // Priority:
    // 1) DH (hard target tile)
    // 2) D / D<number> (AO)
    // 3) Z (fallback)
    const attackFlag = hardTargetFlag || aoFlag || assemblyFlag;
    const attackPos = attackFlag ? toPos(attackFlag.pos) : null;

    // Target room:
    // - If DH is present, engage only in that room
    // - Else if AO present, use AO room
    // - Else stay in assembly room
    const targetRoom = hardTargetFlag
        ? hardTargetFlag.pos.roomName
        : (aoFlag ? aoFlag.pos.roomName : assemblyFlag.pos.roomName);

    // AO center:
    // - If DH present, lock center to DH tile (keeps engage gating in correct room)
    // - Else prefer AO flag position; fallback to assembly.
    const aoCenterPos = hardTargetFlag
        ? toPos(hardTargetFlag.pos)
        : (aoFlag ? toPos(aoFlag.pos) : waitPos);

    const entry = {
        sponsorRoom,
        waitFlagName: assemblyFlag.name,
        assemblyFlagName: assemblyFlag.name,

        // "attack" is a compat anchor flag name (D or Z), not A.
        attackFlagName: attackFlag.name,

        waitPos,
        assemblyPos: waitPos,
        attackPos,
        targetRoom,
        waypointFlagNames,
        ao: {
            targetRoom,
            radius: hardTargetFlag ? 0 : aoRadius,
            centerPos: aoCenterPos
        }
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

            debug('mission.dismantle.flag', `[AssaultDismantleFlag] ${room.name} Z=${entry.waitPos.roomName} target=${entry.targetRoom} aoR=${entry.ao.radius} spawn=${spawnAllowed}`);

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
                    ownerRoom: room.name,
                    squadKey,
                    mode: 'SOLO',
                    assaultRole: 'solo',
                    assaultMode: 'dismantle',

                    // Canonical fields (match assault mission style)
                    flags: {
                        wait: entry.waitFlagName,          // Z
                        assembly: entry.assemblyFlagName,  // Z
                        attack: entry.attackFlagName,      // compat anchor: D or Z
                        waypoints: entry.waypointFlagNames || []
                    },
                    ao: entry.ao,

                    // Legacy convenience fields (kept for compatibility)
                    waitFlagName: entry.waitFlagName,
                    waypointFlagName: FLAG_ASSEMBLY,
                    attackFlagName: entry.attackFlagName,
                    waitPos: entry.waitPos,
                    attackPos: entry.attackPos,
                    targetRoom: entry.targetRoom,
                    sponsorRoom: room.name
                },
                census
            });
        }
    }
};