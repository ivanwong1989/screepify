const missionStates = require('managers_overseer_missions_board_missionStates');
const boardIndexing = require('managers_overseer_missions_board_utils_boardIndexing');
const missionRuntime = require('managers_overseer_missions_board_missionRuntime');

const TERMINAL_RETENTION_TICKS = 20;

function cleanupBoard(board) {
    if (!board || !board.byId) return;
    boardIndexing.repairIndexesIfNeeded(board);

    const byId = board.byId;
    for (const id in byId) {
        const mission = byId[id];
        if (!mission) {
            delete byId[id];
            continue;
        }
        if (!missionStates.TERMINAL_STATES.has(mission.state)) continue;

        const terminalAt = Number.isFinite(mission.terminalTick) ? mission.terminalTick : mission.updatedTick;
        if (Number.isFinite(terminalAt) && (Game.time - terminalAt) < TERMINAL_RETENTION_TICKS) continue;

        boardIndexing.removeIndexes(board, mission);
        delete byId[id];
        missionRuntime.deleteMissionRuntime(id);
    }
}

module.exports = {
    cleanupBoard,
    TERMINAL_RETENTION_TICKS
};

