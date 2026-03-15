const missionMemory = require('managers_overseer_missions_board_missionMemory');
const missionRegistry = require('managers_overseer_missions_board_missionRegistry');
const missionRuntime = require('managers_overseer_missions_board_missionRuntime');
const missionStates = require('managers_overseer_missions_board_missionStates');
const missionCleanup = require('managers_overseer_missions_board_utils_missionCleanup');
const missionThrottle = require('managers_overseer_missions_board_utils_missionThrottle');
const boardIndexing = require('managers_overseer_missions_board_utils_boardIndexing');
const detectors = require('managers_overseer_missions_board_detectors_index');
const registerDefaults = require('managers_overseer_missions_board_registerDefaults');
const missionClasses = require('managers_overseer_missions_board_missionClassifications');
const missionKeys = require('managers_overseer_missions_board_missionKeys');

const DEFAULT_LIVE_TYPE_CAPS = {
    build: 1,
    repair: 2,
    logisticsJob: 8
};
const ALWAYS_CHECK_TYPES = new Set([
    'towerManaged'
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
            legacySkipped: 0,
            throttleFiltered: 0,
            missingHandler: 0,
            invalid: 0,
            refreshError: 0,
            completed: 0
        },
        detectors: {
            total: 0,
            ran: 0,
            filtered: 0,
            errors: 0,
            byName: Object.create(null)
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

function hasLiveMission(key) {
    const mission = getByKey(key);
    return isLiveMission(mission);
}

function patchMission(id, patch) {
    const mission = getById(id);
    if (!mission || !patch) return mission;
    Object.assign(mission, patch);
    mission.updatedTick = Game.time;
    return mission;
}

function setState(id, state, reason) {
    const mission = getById(id);
    if (!mission) return null;
    mission.state = state;
    mission.statusReason = reason || null;
    mission.updatedTick = Game.time;
    mission.lastCheckedTick = Game.time;
    if (missionStates.TERMINAL_STATES.has(state)) {
        mission.terminalTick = Game.time;
    }
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
    return listByRoom(roomName).filter(isLiveMission);
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
    const initialLive = listLiveByRoom(roomName);
    for (let i = 0; i < initialLive.length; i++) {
        const mission = initialLive[i];
        if (!mission || !mission.meta || mission.meta.source !== 'legacy') continue;
        markCancelled(mission.id, 'legacy_migrated');
        if (stats && stats.updates) stats.updates.legacySkipped += 1;
    }

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

function runDetectors(roomName, stats) {
    const roomCtx = missionRuntime.getRoomContext(roomName);
    if (!roomCtx || !roomCtx.room) return;
    detectors.runForRoom(roomCtx, module.exports, stats || null);
}

function cleanup() {
    const board = ensureMemory();
    missionCleanup.cleanupBoard(board);
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
    runDetectors(room.name, stats);
    cleanup();
}

function getMissionContractsForRoom(roomName, filterType) {
    const missions = listLiveByRoom(roomName);
    const out = [];
    for (let i = 0; i < missions.length; i++) {
        const mission = missions[i];
        if (filterType && mission.type !== filterType) continue;
        const handler = missionRegistry.get(mission.type);
        if (!handler || typeof handler.toLegacyMission !== 'function') continue;
        const legacy = handler.toLegacyMission(mission);
        if (legacy) out.push(legacy);
    }
    return out;
}

function getLegacyMissionsForRoom(roomName, filterType) {
    return getMissionContractsForRoom(roomName, filterType);
}

function upsertLegacyMission(roomName, legacyMission, options) {
    const board = ensureMemory();
    const key = missionKeys.makeLegacyKey(roomName, legacyMission);
    if (!key) return null;
    const namespace = options && options.namespace ? String(options.namespace) : null;

    let mission = board.byId[key];
    if (!mission) {
        mission = {
            id: key,
            key,
            type: legacyMission.type || 'legacy',
            class: missionClasses.FINITE,
            state: missionStates.ACTIVE,
            sponsorRoom: roomName,
            targetRoom: roomName,
            priority: Number.isFinite(legacyMission.priority) ? legacyMission.priority : 0,
            createdTick: Game.time,
            updatedTick: Game.time,
            lastCheckedTick: Game.time,
            lastProgressTick: Game.time,
            targetId: legacyMission.targetId || legacyMission.sourceId || null,
            assigned: { primary: [], support: [] },
            demand: null,
            progress: { stage: 'legacy' },
            meta: {
                source: 'legacy',
                legacyName: legacyMission.name || null,
                legacyNamespace: namespace
            },
            statusReason: null,
            legacy: legacyMission
        };
        board.byId[key] = mission;
        boardIndexing.addIndexes(board, mission);
        return mission;
    }

    mission.type = legacyMission.type || mission.type || 'legacy';
    mission.state = missionStates.ACTIVE;
    mission.priority = Number.isFinite(legacyMission.priority) ? legacyMission.priority : (mission.priority || 0);
    mission.updatedTick = Game.time;
    mission.lastCheckedTick = Game.time;
    mission.statusReason = null;
    mission.legacy = legacyMission;
    if (!mission.meta) mission.meta = {};
    mission.meta.source = 'legacy';
    mission.meta.legacyName = legacyMission.name || mission.meta.legacyName || null;
    mission.meta.legacyNamespace = namespace;
    if (mission.meta.terminalTick) delete mission.meta.terminalTick;
    if (mission.terminalTick) delete mission.terminalTick;
    return mission;
}

function upsertLegacyMissions(roomName, legacyMissions, options) {
    const list = Array.isArray(legacyMissions) ? legacyMissions : [];
    const namespace = options && options.namespace ? String(options.namespace) : null;
    const seen = new Set();
    for (let i = 0; i < list.length; i++) {
        const legacyMission = list[i];
        if (!legacyMission) continue;
        const mission = upsertLegacyMission(roomName, legacyMission, options || null);
        if (mission) seen.add(mission.id);
    }

    const roomMissions = listByRoom(roomName);
    for (let i = 0; i < roomMissions.length; i++) {
        const mission = roomMissions[i];
        if (!mission || !mission.meta || mission.meta.source !== 'legacy') continue;
        if (namespace && mission.meta.legacyNamespace !== namespace) continue;
        if (missionStates.TERMINAL_STATES.has(mission.state)) continue;
        if (seen.has(mission.id)) continue;
        markCancelled(mission.id, 'not_detected');
    }
}

function listLegacyContractsForRoom(roomName) {
    const missions = listLiveByRoom(roomName);
    const out = [];
    for (let i = 0; i < missions.length; i++) {
        const mission = missions[i];
        if (!mission || !mission.meta || mission.meta.source !== 'legacy') continue;
        if (!mission.legacy) continue;
        out.push(mission.legacy);
    }
    return out;
}

function listContractMissionsForRoom(roomName) {
    return listLegacyContractsForRoom(roomName);
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
    runMissionUpdates,
    runDetectors,
    cleanup,
    runRoom,
    getMissionContractsForRoom,
    getDemandForRoom,
    getLegacyMissionsForRoom,
    upsertLegacyMissions,
    listLegacyContractsForRoom,
    listContractMissionsForRoom,
    getSummaryForRoom
};

