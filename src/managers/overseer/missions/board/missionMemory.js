const heap = require('utils_heap');

const MISSION_MEMORY_VERSION = 1;
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
    if (!board.cursors || typeof board.cursors !== 'object') board.cursors = {};
    return board;
}

module.exports = {
    MISSION_MEMORY_VERSION,
    ensureMemory
};

