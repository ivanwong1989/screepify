const DEFAULT_PRIORITY = 60;

const MISSION_DEFS = Object.freeze({
    dismantle: {
        label: 'Dismantle a structure at a target position (remote OK).',
        required: ['roomName', 'x', 'y'],
        optional: ['sponsorRoom', 'priority', 'persist', 'label', 'targetId']
    },
    claim: {
        label: 'Claim a target room controller (remote).',
        required: ['roomName'],
        optional: ['sponsorRoom', 'priority', 'persist', 'label']
    },
    reserve: {
        label: 'Reserve a target room controller (remote).',
        required: ['roomName'],
        optional: ['sponsorRoom', 'priority', 'persist', 'label', 'x', 'y']
    },
    drainer: {
        label: 'Drain tower energy by tanking in a target room (remote).',
        required: ['roomName'],
        optional: ['x', 'y', 'sponsorRoom', 'priority', 'persist', 'label', 'targetPos', 'targetRoom']
    },
    move2flag: {
        label: 'Move a single creep along flag waypoints to a target flag (user-directed).',
        required: ['flagName'],
        optional: ['sponsorRoom', 'priority', 'persist', 'label']
    }
});

function ensureStore() {
    if (!Memory.userMissions || typeof Memory.userMissions !== 'object') {
        Memory.userMissions = {};
    }
    const store = Memory.userMissions;
    if (!store.items || typeof store.items !== 'object') store.items = {};
    if (!Number.isFinite(store.count)) store.count = 0;
    if (!Number.isFinite(store.nextId)) store.nextId = 1;

    // Prune legacy/unknown mission types so removed mission types (e.g. transfer)
    // do not linger in memory and continue showing up in console output.
    const keys = Object.keys(store.items);
    if (keys.length > 0) {
        let removed = 0;
        for (let i = 0; i < keys.length; i++) {
            const id = keys[i];
            const item = store.items[id];
            const type = item && item.type ? ('' + item.type).trim().toLowerCase() : '';
            if (!type || !MISSION_DEFS[type]) {
                delete store.items[id];
                removed++;
            }
        }
        if (removed > 0) {
            store.count = Math.max(0, Object.keys(store.items).length);
        }
    }

    return store;
}

function normalizeRoomName(value) {
    if (value === undefined || value === null) return '';
    return ('' + value).trim().toUpperCase();
}

function normalizeBool(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const raw = ('' + value).trim().toLowerCase();
    if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y') return true;
    if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'n') return false;
    return fallback;
}

function clampPosCoord(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    const int = Math.floor(num);
    if (int < 0 || int > 49) return null;
    return int;
}

function normalizeTargetPos(input) {
    if (!input) return null;
    if (input instanceof RoomPosition) {
        return { x: input.x, y: input.y, roomName: input.roomName };
    }
    const roomName = normalizeRoomName(input.roomName || input.room || input.targetRoom);
    const x = clampPosCoord(input.x);
    const y = clampPosCoord(input.y);
    if (!roomName || x === null || y === null) return null;
    return { x, y, roomName };
}

function buildId(store) {
    const id = `u${store.nextId}`;
    store.nextId += 1;
    return id;
}

function getDefinitions() {
    return MISSION_DEFS;
}

function getAll() {
    const store = ensureStore();
    if (!store || !store.items || !Number.isFinite(store.count) || store.count === 0) return [];
    return Object.values(store.items);
}

function getByType(type) {
    if (!type) return [];
    const key = ('' + type).trim().toLowerCase();
    if (!key) return [];
    return getAll().filter(m => m && m.type === key);
}

function addMission(type, data) {
    const store = ensureStore();
    const key = ('' + type).trim().toLowerCase();
    if (!key) return { error: 'Missing mission type.' };
    if (!MISSION_DEFS[key]) return { error: `Unknown mission type: ${key}` };

    const targetPos = normalizeTargetPos(data && (data.targetPos || data.pos || data.target));
    const roomName = normalizeRoomName((data && (data.roomName || data.targetRoom)) || (targetPos && targetPos.roomName));
    const targetRoom = normalizeRoomName(data && data.targetRoom);
    const targetId = data && data.targetId ? ('' + data.targetId).trim() : '';
    const x = clampPosCoord(data && data.x);
    const y = clampPosCoord(data && data.y);
    const finalTargetPos = targetPos || (roomName && x !== null && y !== null ? { x, y, roomName } : null);
    const flagNameRaw = data && (data.flagName || data.flag || data.flagId);
    const flagName = flagNameRaw ? ('' + flagNameRaw).trim() : '';

    if (key === 'dismantle' && !finalTargetPos) {
        return { error: 'Missing target position (roomName, x, y).' };
    }
    if (key === 'reserve' && !roomName) {
        return { error: 'Missing target room (roomName).' };
    }
    if (key === 'claim' && !roomName) {
        return { error: 'Missing target room (roomName).' };
    }
    if (key === 'drainer' && !roomName) {
        return { error: 'Missing target room (roomName).' };
    }
    if (key === 'move2flag' && !flagName) {
        return { error: 'Missing flagName.' };
    }

    const id = buildId(store);
    const mission = {
        id,
        type: key,
        enabled: data && data.enabled === false ? false : true,
        created: Game.time,
        priority: Number.isFinite(data && data.priority) ? data.priority : DEFAULT_PRIORITY,
        sponsorRoom: normalizeRoomName(data && data.sponsorRoom),
        targetPos: finalTargetPos || null,
        targetRoom: key === 'reserve' || key === 'drainer' || key === 'claim'
            ? roomName
            : (targetRoom || null),
        targetId: targetId || null,
        persist: normalizeBool(data && data.persist, false),
        label: data && data.label ? ('' + data.label).trim() : '',
        flagName: key === 'move2flag' ? flagName : null
    };

    store.items[id] = mission;
    store.count += 1;
    return { id, mission };
}

function updateMission(id, patch) {
    const store = ensureStore();
    if (!id || !store.items[id]) return null;
    const item = store.items[id];
    Object.assign(item, patch);
    return item;
}

function removeMission(id) {
    const store = ensureStore();
    if (!id || !store.items[id]) return false;
    delete store.items[id];
    store.count = Math.max(0, (store.count || 1) - 1);
    return true;
}

module.exports = {
    DEFAULT_PRIORITY,
    addMission,
    updateMission,
    removeMission,
    getDefinitions,
    getAll,
    getByType,
    normalizeTargetPos,
    normalizeRoomName,
    clampPosCoord
};
