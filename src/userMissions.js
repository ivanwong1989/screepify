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
    transfer: {
        label: 'Transfer resources from a source structure to a target structure (user-directed logistics).',
        required: ['sourceId', 'targetId'],
        optional: ['resourceType', 'sponsorRoom', 'priority', 'persist', 'label', 'sourceRoom', 'targetRoom', 'count']
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
    return store;
}

function normalizeRoomName(value) {
    if (value === undefined || value === null) return '';
    return ('' + value).trim();
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
    const store = Memory.userMissions;
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

    const sourceIdRaw = data && (data.sourceId || data.source || data.from);
    const targetIdRaw = data && (data.targetId || data.target || data.to);
    const sourceId = sourceIdRaw ? ('' + sourceIdRaw).trim() : '';
    const targetId = targetIdRaw ? ('' + targetIdRaw).trim() : '';

    const targetPos = normalizeTargetPos(data && (data.targetPos || data.pos || data.target));
    const roomName = normalizeRoomName((data && (data.roomName || data.targetRoom)) || (targetPos && targetPos.roomName));
    const transferTargetRoom = normalizeRoomName(data && data.targetRoom);
    const transferSourceRoom = normalizeRoomName(data && data.sourceRoom);
    const x = clampPosCoord(data && data.x);
    const y = clampPosCoord(data && data.y);
    const finalTargetPos = targetPos || (roomName && x !== null && y !== null ? { x, y, roomName } : null);

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
    if (key === 'transfer' && (!sourceId || !targetId)) {
        return { error: 'Missing sourceId or targetId.' };
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
        targetRoom: key === 'reserve' || key === 'drainer' || key === 'claim' ? roomName : (key === 'transfer' ? transferTargetRoom : null),
        sourceRoom: key === 'transfer' ? transferSourceRoom : null,
        sourceId: key === 'transfer' ? sourceId : null,
        resourceType: key === 'transfer' && data && data.resourceType ? ('' + data.resourceType).trim() : null,
        targetId: key === 'transfer' ? targetId : (data && data.targetId ? ('' + data.targetId) : null),
        persist: normalizeBool(data && data.persist, false),
        label: data && data.label ? ('' + data.label).trim() : '',
        count: key === 'transfer' ? (Number.isFinite(Number(data && data.count)) ? Math.max(1, Math.floor(Number(data.count))) : 1) : null
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
