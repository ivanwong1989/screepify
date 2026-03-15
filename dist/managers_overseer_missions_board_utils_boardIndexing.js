function pushUnique(list, value) {
    if (!Array.isArray(list)) return;
    if (list.indexOf(value) !== -1) return;
    list.push(value);
}

function removeValue(list, value) {
    if (!Array.isArray(list)) return;
    const index = list.indexOf(value);
    if (index === -1) return;
    list.splice(index, 1);
}

function addIndexes(board, mission) {
    if (!board || !mission) return;

    const roomName = mission.sponsorRoom || mission.targetRoom || mission.roomName;
    if (roomName) {
        if (!Array.isArray(board.byRoom[roomName])) board.byRoom[roomName] = [];
        pushUnique(board.byRoom[roomName], mission.id);
    }

    if (mission.type) {
        if (!Array.isArray(board.byType[mission.type])) board.byType[mission.type] = [];
        pushUnique(board.byType[mission.type], mission.id);
    }
}

function removeIndexes(board, mission) {
    if (!board || !mission) return;
    const roomName = mission.sponsorRoom || mission.targetRoom || mission.roomName;
    if (roomName && Array.isArray(board.byRoom[roomName])) {
        removeValue(board.byRoom[roomName], mission.id);
        if (board.byRoom[roomName].length === 0) delete board.byRoom[roomName];
    }

    if (mission.type && Array.isArray(board.byType[mission.type])) {
        removeValue(board.byType[mission.type], mission.id);
        if (board.byType[mission.type].length === 0) delete board.byType[mission.type];
    }
}

function repairIndexesIfNeeded(board) {
    if (!board || !board.byId) return;
    const needsRepair = (Game.time % 151) === 0;
    if (!needsRepair) return;

    board.byRoom = {};
    board.byType = {};
    const byId = board.byId;
    for (const id in byId) {
        const mission = byId[id];
        if (!mission || mission.id !== id) continue;
        addIndexes(board, mission);
    }
}

module.exports = {
    addIndexes,
    removeIndexes,
    repairIndexesIfNeeded
};

