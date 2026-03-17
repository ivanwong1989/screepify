const heap = require('utils_heap');

const MISSION_MEMORY_VERSION = 3;
const MISSION_BOARD_HEAP_STORE = 'missionBoard';

function ensureMemory() {
    // Keep missions fully volatile in heap to avoid persistent Memory bloat.
    if (Memory.missions) {
        delete Memory.missions;
    }

    const board = heap.getStore(MISSION_BOARD_HEAP_STORE, { ttl: null });
    if (board.version !== MISSION_MEMORY_VERSION) board.version = MISSION_MEMORY_VERSION;
    if (!board.byId || typeof board.byId !== 'object') board.byId = {};
    if (!board.byRoom || typeof board.byRoom !== 'object') board.byRoom = {};
    if (!board.byType || typeof board.byType !== 'object') board.byType = {};
    if (!board.byNamespace || typeof board.byNamespace !== 'object') board.byNamespace = {};
    if (!board.namespaceMeta || typeof board.namespaceMeta !== 'object') board.namespaceMeta = {};
    if (!board.cursors || typeof board.cursors !== 'object') board.cursors = {};
    if (!board.cache || typeof board.cache !== 'object') board.cache = {};
    if (!board.cache.byRoomLive || typeof board.cache.byRoomLive !== 'object') board.cache.byRoomLive = {};
    if (!board.cache.contractsByRoom || typeof board.cache.contractsByRoom !== 'object') board.cache.contractsByRoom = {};
    if (!Number.isFinite(board.cache.tick) || board.cache.tick !== Game.time) {
        board.cache.tick = Game.time;
        board.cache.byRoomLive = {};
        board.cache.contractsByRoom = {};
    }
    if (!Number.isFinite(board.lastCleanupTick)) board.lastCleanupTick = -1;
    return board;
}

module.exports = {
    MISSION_MEMORY_VERSION,
    ensureMemory
};

