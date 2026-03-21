const missionMemory = require('managers_overseer_missions_board_missionMemory');
const missionRegistry = require('managers_overseer_missions_board_missionRegistry');
const missionRuntime = require('managers_overseer_missions_board_missionRuntime');
const missionStates = require('managers_overseer_missions_board_missionStates');
const missionCleanup = require('managers_overseer_missions_board_utils_missionCleanup');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');
const boardIndexing = require('managers_overseer_missions_board_utils_boardIndexing');
const registerDefaults = require('managers_overseer_missions_board_registerDefaults');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');

const DEFAULT_LIVE_TYPE_CAPS = {
    build: 1,
    repair: 2
};

function ensureStatsStore() {
    if (!global.__missionBoardStats || typeof global.__missionBoardStats !== 'object') {
        global.__missionBoardStats = { byRoom: Object.create(null) };
    }
    if (!global.__missionBoardStats.byRoom) {
        global.__missionBoardStats.byRoom = Object.create(null);
    }
    return global.__missionBoardStats;
}

function beginRoomStats(roomName) {
    if (!roomName) return null;
    const store = ensureStatsStore();
    const stats = {
        tick: Game.time,
        roomName,
        create: {
            attempted: 0,
            created: 0,
            existing: 0,
            capped: 0,
            missingHandler: 0,
            refreshError: 0
        },
        updates: {
            live: 0,
            selected: 0,
            checked: 0,
            throttleFiltered: 0,
            missingHandler: 0,
            invalid: 0,
            refreshError: 0,
            completed: 0
        },
        refresh: {
            total: 0,
            ran: 0,
            skipped: 0,
            errors: 0,
            discovered: 0,
            created: 0,
            stale: 0,
            byType: Object.create(null)
        }
    };
    store.byRoom[roomName] = stats;
    return stats;
}

function getRoomStats(roomName) {
    if (!roomName) return null;
    const store = ensureStatsStore();
    const stats = store.byRoom[roomName];
    if (!stats || stats.tick !== Game.time) return null;
    return stats;
}

function bumpCreateStat(roomName, field) {
    if (!roomName || !field) return;
    const stats = getRoomStats(roomName);
    if (!stats || !stats.create) return;
    stats.create[field] = (stats.create[field] || 0) + 1;
}

function ensureMemory() {
    registerDefaults.ensureRegistered();
    return missionMemory.ensureMemory();
}

function getById(id) {
    const board = ensureMemory();
    return board.byId[id] || null;
}

function getByKey(key) {
    return getById(key);
}

function isLiveMission(mission) {
    return !!(mission && missionStates.LIVE_STATES.has(mission.state));
}


function getMissionNamespace(mission) {
    return mission && mission.meta && mission.meta.namespace
        ? mission.meta.namespace
        : null;
}

function invalidateRoomCaches(board, roomNames) {
    if (!board || !board.cache) return;
    if (!Array.isArray(roomNames) || roomNames.length <= 0) return;
    for (let i = 0; i < roomNames.length; i++) {
        const roomName = roomNames[i];
        if (!roomName) continue;
        if (board.cache.byRoomLive) delete board.cache.byRoomLive[roomName];
        if (board.cache.contractsByRoom) delete board.cache.contractsByRoom[roomName];
    }
}

function invalidateMissionCaches(board, mission, previous) {
    if (!board || !board.cache) return;
    const roomNames = [];
    if (mission) {
        roomNames.push(mission.sponsorRoom || null, mission.targetRoom || null, mission.roomName || null);
    }
    if (previous) {
        roomNames.push(previous.sponsorRoom || null, previous.targetRoom || null, previous.roomName || null);
    }
    invalidateRoomCaches(board, roomNames);
}

function updateIndexesForMissionPatch(board, mission, previous) {
    if (!board || !mission) return;
    const prevRoom = previous ? (previous.sponsorRoom || previous.targetRoom || previous.roomName) : null;
    const nextRoom = mission.sponsorRoom || mission.targetRoom || mission.roomName;
    const prevType = previous ? previous.type : null;
    const nextType = mission.type || null;
    const prevNamespace = previous ? previous.namespace : null;
    const nextNamespace = getMissionNamespace(mission);
    if (prevRoom === nextRoom && prevType === nextType && prevNamespace === nextNamespace) return;
    if (previous) boardIndexing.removeIndexes(board, previous);
    boardIndexing.addIndexes(board, mission);
}

function snapshotMissionIndexFields(mission) {
    if (!mission) return null;
    return {
        sponsorRoom: mission.sponsorRoom || null,
        targetRoom: mission.targetRoom || null,
        roomName: mission.roomName || null,
        type: mission.type || null,
        namespace: getMissionNamespace(mission),
        meta: mission.meta ? Object.assign({}, mission.meta) : null
    };
}

function hasLiveMission(key) {
    const mission = getByKey(key);
    return isLiveMission(mission);
}

function patchMission(id, patch) {
    const board = ensureMemory();
    const mission = board.byId[id] || null;
    if (!mission || !patch) return mission;
    const previous = snapshotMissionIndexFields(mission);
    Object.assign(mission, patch);
    updateIndexesForMissionPatch(board, mission, previous);
    invalidateMissionCaches(board, mission, previous);
    mission.updatedTick = Game.time;
    return mission;
}

function setState(id, state, reason) {
    const board = ensureMemory();
    const mission = board.byId[id] || null;
    if (!mission) return null;
    mission.state = state;
    mission.statusReason = reason || null;
    mission.updatedTick = Game.time;
    mission.lastCheckedTick = Game.time;
    if (missionStates.TERMINAL_STATES.has(state)) {
        mission.terminalTick = Game.time;
    }
    invalidateMissionCaches(board, mission, null);
    return mission;
}

function markDone(id, reason) {
    return setState(id, missionStates.DONE, reason || 'done');
}

function markCancelled(id, reason) {
    return setState(id, missionStates.CANCELLED, reason || 'cancelled');
}

function markExpired(id, reason) {
    return setState(id, missionStates.EXPIRED, reason || 'expired');
}

function removeMission(id) {
    const board = ensureMemory();
    const mission = board.byId[id];
    if (!mission) return false;
    boardIndexing.removeIndexes(board, mission);
    delete board.byId[id];
    invalidateMissionCaches(board, mission, null);
    missionRuntime.deleteMissionRuntime(id);
    return true;
}

function listAll() {
    const board = ensureMemory();
    return Object.values(board.byId);
}

function listByRoom(roomName) {
    const board = ensureMemory();
    const ids = board.byRoom[roomName] || [];
    const result = [];
    for (let i = 0; i < ids.length; i++) {
        const mission = board.byId[ids[i]];
        if (mission) result.push(mission);
    }
    return result;
}

function listByType(type) {
    const board = ensureMemory();
    const ids = board.byType[type] || [];
    const result = [];
    for (let i = 0; i < ids.length; i++) {
        const mission = board.byId[ids[i]];
        if (mission) result.push(mission);
    }
    return result;
}

function listActive() {
    return listAll().filter(m => m.state === missionStates.ACTIVE);
}

function listLiveByRoom(roomName) {
    const board = ensureMemory();
    const cache = board.cache || null;
    if (!cache || !roomName) return listByRoom(roomName).filter(isLiveMission);
    const cached = cache.byRoomLive && cache.byRoomLive[roomName];
    if (cached && cached.tick === Game.time && Array.isArray(cached.value)) {
        return cached.value;
    }

    const value = listByRoom(roomName).filter(isLiveMission);
    if (cache.byRoomLive) {
        cache.byRoomLive[roomName] = {
            tick: Game.time,
            value
        };
    }
    return value;
}

function listLiveByNamespace(roomName, namespace, type) {
    const board = ensureMemory();
    if (!roomName || !namespace) return [];
    const key = boardIndexing.makeNamespaceKey(roomName, namespace, type || '*');
    const ids = board.byNamespace && key ? board.byNamespace[key] : null;
    if (!Array.isArray(ids) || ids.length <= 0) return [];

    const result = [];
    for (let i = 0; i < ids.length; i++) {
        const mission = board.byId[ids[i]];
        if (!isLiveMission(mission)) continue;
        result.push(mission);
    }
    return result;
}

function getTypeLiveCap(roomName, type) {
    if (!type) return null;

    const defaultCap = DEFAULT_LIVE_TYPE_CAPS[type];
    const room = roomName ? Game.rooms[roomName] : null;
    const overrideCaps = room && room.memory && room.memory.overseer && room.memory.overseer.missionCaps
        ? room.memory.overseer.missionCaps
        : null;
    const override = overrideCaps ? overrideCaps[type] : null;

    if (Number.isFinite(override) && override >= 0) return override;
    if (Number.isFinite(defaultCap) && defaultCap >= 0) return defaultCap;
    return null;
}

function isTypeAtCap(roomName, type) {
    const cap = getTypeLiveCap(roomName, type);
    if (!Number.isFinite(cap)) return false;
    if (cap <= 0) return true;

    const live = listLiveByRoom(roomName);
    let count = 0;
    for (let i = 0; i < live.length; i++) {
        if (live[i] && live[i].type === type) count++;
        if (count >= cap) return true;
    }
    return false;
}

function createMission(type, context, runtimeCtx, options) {
    const board = ensureMemory();
    const roomName = (context && (context.targetRoom || context.sponsorRoom)) || null;
    if (roomName) bumpCreateStat(roomName, 'attempted');
    const handler = missionRegistry.get(type);
    if (!handler) {
        if (roomName) bumpCreateStat(roomName, 'missingHandler');
        return null;
    }
    const key = handler.makeKey(context);
    const existing = getByKey(key);
    if (existing && isLiveMission(existing)) {
        if (roomName) bumpCreateStat(roomName, 'existing');
        return existing;
    }

    if (roomName && isTypeAtCap(roomName, type)) {
        bumpCreateStat(roomName, 'capped');
        return null;
    }

    const mission = handler.create(context);
    mission.id = key;
    mission.key = key;
    mission.type = type;
    mission.state = mission.state || missionStates.ACTIVE;
    mission.createdTick = Game.time;
    mission.updatedTick = Game.time;
    mission.lastCheckedTick = 0;
    mission.lastProgressTick = mission.lastProgressTick || Game.time;
    mission.statusReason = mission.statusReason || null;

    board.byId[key] = mission;
    boardIndexing.addIndexes(board, mission);
    invalidateMissionCaches(board, mission, null);

    const skipInitialRefresh = !!(options && options.skipInitialRefresh === true);
    if (!skipInitialRefresh && handler.refresh) {
        try {
            handler.refresh(mission, runtimeCtx || null);
            mission.updatedTick = Game.time;
        } catch (err) {
            markCancelled(mission.id, 'refresh_error');
            if (roomName) bumpCreateStat(roomName, 'refreshError');
            if (typeof debug === 'function') {
                debug('missions', `[MissionBoard] create refresh failed id=${mission.id} err=${err && err.message}`);
            }
        }
    }

    if (roomName) bumpCreateStat(roomName, 'created');

    return mission;
}

function getDemandForRoom(roomName) {
    const missions = listLiveByRoom(roomName);
    const demand = [];
    for (let i = 0; i < missions.length; i++) {
        const mission = missions[i];
        const handler = missionRegistry.get(mission.type);
        if (!handler || typeof handler.getDemand !== 'function') continue;
        const d = handler.getDemand(mission, missionRuntime.getRoomContext(roomName));
        if (!d || !d.count || d.count <= 0) continue;
        demand.push({
            missionId: mission.id,
            type: mission.type,
            role: d.role,
            needed: d.count,
            assigned: mission.assigned && mission.assigned.primary ? mission.assigned.primary.length : 0,
            priority: Number.isFinite(d.priority) ? d.priority : (mission.priority || 0),
            sponsorRoom: mission.sponsorRoom || roomName
        });
    }
    return demand;
}

function indexDesiredByKey(desiredList) {
    const index = Object.create(null);
    if (!Array.isArray(desiredList)) return index;
    for (let i = 0; i < desiredList.length; i++) {
        const desired = desiredList[i];
        if (!desired || !desired.key) continue;
        index[desired.key] = desired;
    }
    return index;
}

function indexMissionsByKey(missions) {
    const index = Object.create(null);
    if (!Array.isArray(missions)) return index;
    for (let i = 0; i < missions.length; i++) {
        const mission = missions[i];
        if (!mission || !mission.key) continue;
        index[mission.key] = mission;
    }
    return index;
}

function safeDiscover(handler, runtimeCtx) {
    if (!handler || typeof handler.discover !== 'function') return [];
    try {
        const desired = handler.discover({
            room: runtimeCtx.room || null,
            intel: runtimeCtx.intel || null,
            context: runtimeCtx.context || null,
            runtime: runtimeCtx,
            missionBoard: module.exports
        });
        if (!Array.isArray(desired) || desired.length <= 0) return [];
        const out = [];
        for (let i = 0; i < desired.length; i++) {
            const descriptor = desired[i];
            if (!descriptor || !descriptor.key || !descriptor.createContext) continue;
            out.push(descriptor);
        }
        return out;
    } catch (err) {
        if (typeof debug === 'function') {
            debug('missions', `[MissionBoard] discover error type=${handler && handler.type ? handler.type : 'unknown'} err=${err && err.message}`);
        }
        return [];
    }
}

function safeValidate(handler, mission, runtimeCtx, stats) {
    if (!handler || typeof handler.validate !== 'function') return true;
    try {
        return !!handler.validate(mission, runtimeCtx);
    } catch (err) {
        if (stats && stats.refresh) stats.refresh.errors = (stats.refresh.errors || 0) + 1;
        if (typeof debug === 'function') {
            debug('missions', `[MissionBoard] validate error id=${mission && mission.id} err=${err && err.message}`);
        }
        return false;
    }
}

function safeRefresh(handler, mission, runtimeCtx, discovered, stats) {
    if (!handler || typeof handler.refresh !== 'function') return true;
    try {
        handler.refresh(mission, runtimeCtx, discovered || null);
        return true;
    } catch (err) {
        if (stats && stats.refresh) stats.refresh.errors = (stats.refresh.errors || 0) + 1;
        if (typeof debug === 'function') {
            debug('missions', `[MissionBoard] refresh error id=${mission && mission.id} err=${err && err.message}`);
        }
        return false;
    }
}

function safeIsComplete(handler, mission, runtimeCtx, stats) {
    if (!handler || typeof handler.isComplete !== 'function') return false;
    try {
        return !!handler.isComplete(mission, runtimeCtx);
    } catch (err) {
        if (stats && stats.refresh) stats.refresh.errors = (stats.refresh.errors || 0) + 1;
        if (typeof debug === 'function') {
            debug('missions', `[MissionBoard] complete check error id=${mission && mission.id} err=${err && err.message}`);
        }
        return false;
    }
}

function safeOnInvalid(handler, mission, runtimeCtx) {
    if (!handler || typeof handler.onInvalid !== 'function') return;
    try { handler.onInvalid(mission, runtimeCtx); } catch (err) {}
}

function safeOnComplete(handler, mission, runtimeCtx) {
    if (!handler || typeof handler.onComplete !== 'function') return;
    try { handler.onComplete(mission, runtimeCtx); } catch (err) {}
}

function safeOnMissing(handler, mission, runtimeCtx) {
    if (!handler || typeof handler.onMissing !== 'function') return;
    try { handler.onMissing(mission, runtimeCtx); } catch (err) {}
}

function safeOnCreate(handler, mission, runtimeCtx, discovered) {
    if (!handler || typeof handler.onCreate !== 'function') return;
    try { handler.onCreate(mission, runtimeCtx, discovered || null); } catch (err) {}
}

function safeCompleteCheck(handler, mission, runtimeCtx, stats) {
    const complete = safeIsComplete(handler, mission, runtimeCtx, stats);
    if (!complete) return false;
    markDone(mission.id, 'complete');
    safeOnComplete(handler, mission, runtimeCtx);
    return true;
}

function createDiscoveredMission(type, handler, desired, runtimeCtx, stats) {
    if (!desired || !desired.createContext) return null;
    const created = createMission(type, desired.createContext, runtimeCtx, { skipInitialRefresh: true });
    if (!created) return null;
    if (stats && stats.refresh) stats.refresh.created = (stats.refresh.created || 0) + 1;
    safeOnCreate(handler, created, runtimeCtx, desired);
    return created;
}

function runMissionTypeRefresh({
    type,
    handler,
    roomName,
    roomCtx,
    stats
}) {
    const runtimeCtx = {
        room: roomCtx.room || Game.rooms[roomName] || null,
        intel: roomCtx.intel || null,
        context: roomCtx.context || null
    };

    const desiredList = safeDiscover(handler, runtimeCtx);
    const desiredByKey = indexDesiredByKey(desiredList);
    const live = listLiveByRoom(roomName).filter(m => m.type === type);
    const liveByKey = indexMissionsByKey(live);

    if (stats && stats.refresh) {
        stats.refresh.discovered = (stats.refresh.discovered || 0) + desiredList.length;
        if (!stats.refresh.byType[type]) {
            stats.refresh.byType[type] = { runs: 0, discovered: 0, created: 0, stale: 0, errors: 0 };
        }
        stats.refresh.byType[type].runs += 1;
        stats.refresh.byType[type].discovered += desiredList.length;
    }

    for (let i = 0; i < desiredList.length; i++) {
        const desired = desiredList[i];
        const existing = liveByKey[desired.key];

        if (!existing) {
            const created = createDiscoveredMission(type, handler, desired, runtimeCtx, stats);
            if (created) {
                if (stats && stats.refresh && stats.refresh.byType[type]) stats.refresh.byType[type].created += 1;
                const refreshed = safeRefresh(handler, created, runtimeCtx, desired, stats);
                if (refreshed) safeCompleteCheck(handler, created, runtimeCtx, stats);
            }
            continue;
        }

        const valid = safeValidate(handler, existing, runtimeCtx, stats);
        if (!valid) {
            markCancelled(existing.id, 'invalid');
            safeOnInvalid(handler, existing, runtimeCtx);

            const recreated = createDiscoveredMission(type, handler, desired, runtimeCtx, stats);
            if (recreated) {
                if (stats && stats.refresh && stats.refresh.byType[type]) stats.refresh.byType[type].created += 1;
                const refreshed = safeRefresh(handler, recreated, runtimeCtx, desired, stats);
                if (refreshed) safeCompleteCheck(handler, recreated, runtimeCtx, stats);
            }
            continue;
        }

        const refreshed = safeRefresh(handler, existing, runtimeCtx, desired, stats);
        if (refreshed) {
            safeCompleteCheck(handler, existing, runtimeCtx, stats);
            existing.lastCheckedTick = Game.time;
            existing.updatedTick = Game.time;
        }
    }

    for (let i = 0; i < live.length; i++) {
        const mission = live[i];
        if (desiredByKey[mission.key]) continue;

        if (stats && stats.refresh) {
            stats.refresh.stale = (stats.refresh.stale || 0) + 1;
            if (stats.refresh.byType[type]) stats.refresh.byType[type].stale += 1;
        }

        const complete = safeIsComplete(handler, mission, runtimeCtx, stats);
        if (complete) {
            markDone(mission.id, 'complete');
            safeOnComplete(handler, mission, runtimeCtx);
            continue;
        }

        const valid = safeValidate(handler, mission, runtimeCtx, stats);
        if (!valid || mission.class === missionClasses.SERVICE) {
            markCancelled(mission.id, 'missing_from_discovery');
            safeOnMissing(handler, mission, runtimeCtx);
            continue;
        }

        const refreshed = safeRefresh(handler, mission, runtimeCtx, null, stats);
        if (refreshed) {
            mission.lastCheckedTick = Game.time;
            mission.updatedTick = Game.time;
        }
    }
}

function runMissionRefresh(roomName, stats) {
    ensureMemory();

    const roomCtx = missionRuntime.getRoomContext(roomName);
    if (!roomCtx || !roomCtx.room) return;

    const handlers = missionRegistry.getAll();
    for (const type in handlers) {
        if (!Object.prototype.hasOwnProperty.call(handlers, type)) continue;
        const handler = handlers[type];

        if (stats && stats.refresh) {
            stats.refresh.total = (stats.refresh.total || 0) + 1;
            if (!stats.refresh.byType[type]) {
                stats.refresh.byType[type] = { runs: 0, discovered: 0, created: 0, stale: 0, errors: 0 };
            }
        }

        if (!handler || typeof handler.discover !== 'function') {
            if (stats && stats.refresh) stats.refresh.skipped = (stats.refresh.skipped || 0) + 1;
            continue;
        }

        if (!missionThrottle.shouldRunMissionRefresh(type, roomName, Game.time)) {
            if (stats && stats.refresh) stats.refresh.skipped = (stats.refresh.skipped || 0) + 1;
            continue;
        }

        try {
            runMissionTypeRefresh({
                type,
                handler,
                roomName,
                roomCtx,
                stats
            });
            if (stats && stats.refresh) stats.refresh.ran = (stats.refresh.ran || 0) + 1;
        } catch (err) {
            if (stats && stats.refresh) {
                stats.refresh.errors = (stats.refresh.errors || 0) + 1;
                if (stats.refresh.byType[type]) stats.refresh.byType[type].errors += 1;
            }
            if (typeof debug === 'function') {
                debug('missions', `[MissionBoard] refresh error type=${type} err=${err && err.message}`);
            }
        }
    }
}

function cleanup() {
    const board = ensureMemory();
    if (board.lastCleanupTick === Game.time) return;
    missionCleanup.cleanupBoard(board);
    board.lastCleanupTick = Game.time;
}

function runRoom(room, data) {
    ensureMemory();
    missionRuntime.setRoomContext(room.name, {
        room,
        intel: data && data.intel ? data.intel : null,
        context: data && data.context ? data.context : null
    });
    const stats = beginRoomStats(room.name);
    runMissionRefresh(room.name, stats);
    cleanup();
}

function getMissionContractsForRoom(roomName, filterType) {
    const board = ensureMemory();
    const cache = board.cache || null;
    let roomCache = cache && cache.contractsByRoom ? cache.contractsByRoom[roomName] : null;
    if (!roomCache || roomCache.tick !== Game.time) {
        const grouped = Object.create(null);
        const all = [];
        const missions = listLiveByRoom(roomName);
        for (let i = 0; i < missions.length; i++) {
            const mission = missions[i];
            const handler = missionRegistry.get(mission.type);
            if (!handler || typeof handler.toContractMission !== 'function') continue;
            const contract = handler.toContractMission(mission);
            if (!contract) continue;
            all.push(contract);
            if (!grouped[mission.type]) grouped[mission.type] = [];
            grouped[mission.type].push(contract);
        }
        roomCache = {
            tick: Game.time,
            all,
            grouped
        };
        if (cache && cache.contractsByRoom) cache.contractsByRoom[roomName] = roomCache;
    }

    if (!filterType) return roomCache.all || [];
    return roomCache.grouped && roomCache.grouped[filterType] ? roomCache.grouped[filterType] : [];
}

function getSummaryForRoom(roomName) {
    const missions = listByRoom(roomName);
    const byState = Object.create(null);
    const byType = Object.create(null);
    let live = 0;
    let terminal = 0;
    for (let i = 0; i < missions.length; i++) {
        const mission = missions[i];
        if (!mission) continue;
        const state = mission.state || 'unknown';
        const type = mission.type || 'unknown';
        byState[state] = (byState[state] || 0) + 1;
        byType[type] = (byType[type] || 0) + 1;
        if (missionStates.TERMINAL_STATES.has(state)) terminal++;
        else live++;
    }

    return {
        tick: Game.time,
        roomName,
        total: missions.length,
        live,
        terminal,
        byState,
        byType,
        demandCount: getDemandForRoom(roomName).length,
        runtime: getRoomStats(roomName)
    };
}

module.exports = {
    ensureMemory,
    getById,
    getByKey,
    hasLiveMission,
    createMission,
    patchMission,
    setState,
    markDone,
    markCancelled,
    markExpired,
    removeMission,
    listAll,
    listByRoom,
    listByType,
    listActive,
    listLiveByRoom,
    listLiveByNamespace,
    runMissionRefresh,
    cleanup,
    runRoom,
    getMissionContractsForRoom,
    getDemandForRoom,
    getSummaryForRoom
};
