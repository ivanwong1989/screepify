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
    repair: 2,
    logisticsJob: 8
};
const ALWAYS_CHECK_TYPES = new Set([
    'tower'
]);

function isDebugLogisticsSupplyEnabled() {
    return !!(Memory && Memory.debugLogisticsSupply === true);
}

function isSupplyExtensionOrSpawnMission(mission) {
    if (!mission || mission.type !== 'logisticsJob') return false;
    const meta = mission.meta || {};
    if (meta.kind !== 'supply') return false;
    const targetId = meta.targetId || mission.targetId;
    if (!targetId) return false;
    const target = Game.getObjectById(targetId);
    if (!target) return false;
    return target.structureType === STRUCTURE_EXTENSION || target.structureType === STRUCTURE_SPAWN;
}

function debugSupplyLifecycle(prefix, mission, extra) {
    if (!isDebugLogisticsSupplyEnabled()) return;
    if (!isSupplyExtensionOrSpawnMission(mission)) return;
    const targetId = mission && mission.meta && mission.meta.targetId ? mission.meta.targetId : mission.targetId;
    const target = targetId ? Game.getObjectById(targetId) : null;
    const free = target && target.store && typeof target.store.getFreeCapacity === 'function'
        ? target.store.getFreeCapacity(RESOURCE_ENERGY)
        : null;
    console.log(
        `[LogisticsSupply][Board] ${prefix} id=${mission.id} room=${mission.sponsorRoom} target=${targetId}` +
        ` type=${target && target.structureType ? target.structureType : '-'} free=${free !== null ? free : '-'}${extra ? ` ${extra}` : ''}`
    );
}

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
        reconcile: {
            total: 0,
            ran: 0,
            skipped: 0,
            errors: 0,
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
    debugSupplyLifecycle(`state=${state}`, mission, `reason=${reason || '-'}`);
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

function createMission(type, context, runtimeCtx) {
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
        debugSupplyLifecycle('existing', existing, `createType=${type}`);
        return existing;
    }

    if (roomName && isTypeAtCap(roomName, type)) {
        bumpCreateStat(roomName, 'capped');
        if (isDebugLogisticsSupplyEnabled() && type === 'logisticsJob' && context && context.kind === 'supply') {
            const target = context.targetId ? Game.getObjectById(context.targetId) : null;
            const isExtOrSpawn = !!(target && (target.structureType === STRUCTURE_EXTENSION || target.structureType === STRUCTURE_SPAWN));
            if (isExtOrSpawn) {
                console.log(
                    `[LogisticsSupply][Board] capped room=${roomName} target=${context.targetId} type=${target.structureType}`
                );
            }
        }
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

    if (handler.refresh) {
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
    debugSupplyLifecycle('created', mission, `createType=${type}`);

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

function getTickSlice(roomName, missions) {
    const board = ensureMemory();
    const total = missions.length;
    if (total <= 4) return missions;
    const cursor = Number.isFinite(board.cursors[roomName]) ? board.cursors[roomName] : 0;
    const size = Math.max(3, Math.ceil(total / 3));
    const slice = [];
    for (let i = 0; i < size; i++) {
        const idx = (cursor + i) % total;
        slice.push(missions[idx]);
    }
    board.cursors[roomName] = (cursor + size) % total;
    return slice;
}

function runMissionUpdates(roomName, stats) {
    ensureMemory();
    const roomCtx = missionRuntime.getRoomContext(roomName) || {};
    const live = listLiveByRoom(roomName);
    const finite = [];
    const slicedCandidates = [];
    for (let i = 0; i < live.length; i++) {
        const mission = live[i];
        if (!mission) continue;
        if (ALWAYS_CHECK_TYPES.has(mission.type)) {
            finite.push(mission);
            continue;
        }
        if (mission.class === missionClasses.FINITE) finite.push(mission);
        else slicedCandidates.push(mission);
    }
    const selected = finite.concat(getTickSlice(roomName, slicedCandidates));
    if (stats && stats.updates) {
        stats.updates.live = live.length;
        stats.updates.selected = selected.length;
    }

    for (let i = 0; i < selected.length; i++) {
        const mission = selected[i];
        if (!missionThrottle.shouldCheckMission(mission, Game.time)) {
            if (stats && stats.updates) stats.updates.throttleFiltered += 1;
            continue;
        }
        if (stats && stats.updates) stats.updates.checked += 1;

        const handler = missionRegistry.get(mission.type);
        if (!handler) {
            markCancelled(mission.id, 'missing_handler');
            if (stats && stats.updates) stats.updates.missingHandler += 1;
            continue;
        }

        const runtime = missionRuntime.getMissionRuntime(mission);
        runtime.room = roomCtx.room || Game.rooms[roomName] || null;
        runtime.intel = roomCtx.intel || null;
        runtime.context = roomCtx.context || null;

        let valid = true;
        if (handler.validate) {
            try {
                valid = !!handler.validate(mission, runtime);
            } catch (err) {
                valid = false;
                if (typeof debug === 'function') {
                    debug('missions', `[MissionBoard] validate error id=${mission.id} err=${err && err.message}`);
                }
            }
        }

        if (!valid) {
            markCancelled(mission.id, 'invalid');
            if (stats && stats.updates) stats.updates.invalid += 1;
            if (handler.onInvalid) {
                try { handler.onInvalid(mission, runtime); } catch (err) {}
            }
            continue;
        }

        if (handler.refresh) {
            try { handler.refresh(mission, runtime); } catch (err) {
                markBlocked(mission.id, 'refresh_error');
                if (stats && stats.updates) stats.updates.refreshError += 1;
                continue;
            }
        }

        const complete = handler.isComplete ? !!handler.isComplete(mission, runtime) : false;
        if (complete) {
            markDone(mission.id, 'complete');
            if (stats && stats.updates) stats.updates.completed += 1;
            if (handler.onComplete) {
                try { handler.onComplete(mission, runtime); } catch (err) {}
            }
            continue;
        }

        mission.lastCheckedTick = Game.time;
        mission.updatedTick = Game.time;
    }
}

function markBlocked(id, reason) {
    return setState(id, missionStates.BLOCKED, reason || 'blocked');
}

function runMissionReconciliation(roomName, stats) {
    const roomCtx = missionRuntime.getRoomContext(roomName);
    if (!roomCtx || !roomCtx.room) return;
    const handlers = missionRegistry.getAll();
    const types = Object.keys(handlers);
    for (let i = 0; i < types.length; i++) {
        const type = types[i];
        const handler = handlers[type];
        if (stats && stats.reconcile) {
            stats.reconcile.total = (stats.reconcile.total || 0) + 1;
            if (!stats.reconcile.byType) stats.reconcile.byType = Object.create(null);
            if (!stats.reconcile.byType[type]) {
                stats.reconcile.byType[type] = { runs: 0, created: 0, skipped: 0, errors: 0 };
            }
        }
        if (!handler || typeof handler.reconcileRoom !== 'function') {
            if (stats && stats.reconcile) {
                stats.reconcile.skipped = (stats.reconcile.skipped || 0) + 1;
                stats.reconcile.byType[type].skipped = (stats.reconcile.byType[type].skipped || 0) + 1;
            }
            continue;
        }

        const createdBefore = stats && stats.create ? (stats.create.created || 0) : 0;
        try {
            handler.reconcileRoom({
                room: roomCtx.room,
                intel: roomCtx.intel,
                context: roomCtx.context,
                missionBoard: module.exports,
                stats: stats || null
            });
            if (stats && stats.reconcile) {
                stats.reconcile.ran = (stats.reconcile.ran || 0) + 1;
                stats.reconcile.byType[type].runs += 1;
                const createdAfter = stats.create ? (stats.create.created || 0) : createdBefore;
                const delta = Math.max(0, createdAfter - createdBefore);
                stats.reconcile.byType[type].created += delta;
                if (delta <= 0) {
                    stats.reconcile.skipped = (stats.reconcile.skipped || 0) + 1;
                    stats.reconcile.byType[type].skipped = (stats.reconcile.byType[type].skipped || 0) + 1;
                }
            }
        } catch (err) {
            if (stats && stats.reconcile) {
                stats.reconcile.errors = (stats.reconcile.errors || 0) + 1;
                stats.reconcile.byType[type].errors += 1;
            }
            if (typeof debug === 'function') {
                debug('missions', `[MissionBoard] reconcile error type=${type} err=${err && err.message}`);
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
    runMissionUpdates(room.name, stats);
    runMissionReconciliation(room.name, stats);
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
    runMissionUpdates,
    runMissionReconciliation,
    cleanup,
    runRoom,
    getMissionContractsForRoom,
    getDemandForRoom,
    getSummaryForRoom
};
