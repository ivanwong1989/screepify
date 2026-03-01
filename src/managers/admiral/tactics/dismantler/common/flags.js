function toPlainPos(pos) {
    if (!pos) return null;
    return { x: pos.x, y: pos.y, roomName: pos.roomName };
}

function getFlag(flagName) {
    if (!flagName) return null;
    const flag = Game.flags && Game.flags[flagName];
    return flag || null;
}

function getFlagPos(flagName) {
    const flag = getFlag(flagName);
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

// "A12" / "B6" / "A" / "B" -> { squadKey: "A"|"B"|null, aoRadius: number|undefined }
function parseAttackFlagName(flagName) {
    if (!flagName || typeof flagName !== 'string') return { squadKey: null, aoRadius: undefined };
    const s = flagName.trim();
    if (!s) return { squadKey: null, aoRadius: undefined };

    const head = s[0].toUpperCase();
    const squadKey = (head === 'A' || head === 'B') ? head : null;

    const m = s.slice(1).match(/(\d+)/);
    if (!m) return { squadKey, aoRadius: undefined };

    const n = parseInt(m[1], 10);
    return { squadKey, aoRadius: Number.isFinite(n) ? n : undefined };
}

// Mission uses "A" / "B" as key; find actual flag by prefix.
// Selection rules:
// 1) exact match if exists ("A")
// 2) else any flag whose name starts with "A" (case-insensitive)
// 3) deterministic: pick lexicographically smallest name
function resolveAttackFlag(attackKeyOrName) {
    if (!attackKeyOrName) return null;
    if (typeof attackKeyOrName !== 'string') return null;

    const raw = attackKeyOrName;
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // 1) Exact match (raw then trimmed)
    let exact = getFlag(raw);
    if (!exact && trimmed !== raw) exact = getFlag(trimmed);
    if (exact) return exact;

    const flags = Game.flags || {};

    // 2) Case-insensitive exact match (handles "a3" vs "A3")
    const upper = trimmed.toUpperCase();
    for (const name in flags) {
        if (String(name).toUpperCase() === upper) return flags[name];
    }

    // 3) Prefix by squad head ALWAYS (so "A3" still maps to squad A)
    const head = upper[0];
    if (head !== 'A' && head !== 'B') return null;

    const candidates = [];
    for (const name in flags) {
        if (!name) continue;
        if (String(name).toUpperCase().startsWith(head)) {
            candidates.push(flags[name]);
        }
    }
    if (candidates.length === 0) return null;

    candidates.sort((f1, f2) => String(f1.name).localeCompare(String(f2.name)));
    return candidates[0];
}

function resolveFlags(mission) {
    const data = (mission && mission.data) || {};
    const flags = data.flags || {};

    const waitFlag = getFlag(flags.wait);
    const assemblyFlag = getFlag(flags.assembly);

    // ✅ NEW: resolve attack flag by squad key/prefix (A/B) or exact name
    const attackFlag = resolveAttackFlag(flags.attack);

    const waitFlagPos = waitFlag ? toPlainPos(waitFlag.pos) : null;
    const attackPos = attackFlag ? toPlainPos(attackFlag.pos) : null;
    const assemblyFlagPos = assemblyFlag ? toPlainPos(assemblyFlag.pos) : null;

    const waypointPositions = Array.isArray(flags.waypoints)
        ? flags.waypoints.map(getFlagPos).filter(p => p)
        : [];

    const fallbackRoom = data.ownerRoom || data.sponsorRoom || (data.ao && data.ao.targetRoom);
    const ownerAnchorPos = getOwnerAnchorPos(fallbackRoom);
    const hasAnyFlag = !!(waitFlagPos || attackPos || assemblyFlagPos || waypointPositions.length > 0);
    const safeFallback = ownerAnchorPos || buildFallbackPos(fallbackRoom);

    const waitPos = waitFlagPos || ownerAnchorPos || (!hasAnyFlag ? safeFallback : null);
    const assemblyPos = assemblyFlagPos || waitFlagPos || ownerAnchorPos || safeFallback;

    // parse override from the *resolved* attack flag name (A12/B6)
    const parsedAttack = attackFlag ? parseAttackFlagName(attackFlag.name) : { squadKey: null, aoRadius: undefined };

    return {
        waitPos,
        attackPos: attackPos || null,
        assemblyPos: assemblyPos || null,
        waypointPositions,
        anchorPos: ownerAnchorPos || null,

        // ✅ NEW fields used by AO + logging/debug
        waitFlag,
        attackFlag,
        assemblyFlag,
        attackFlagName: attackFlag ? attackFlag.name : (flags.attack || null),
        attackSquadKey: parsedAttack.squadKey,
        attackAoRadiusOverride: parsedAttack.aoRadius
    };
}

module.exports = {
    resolveFlags,
    parseAttackFlagName,
    resolveAttackFlag
};