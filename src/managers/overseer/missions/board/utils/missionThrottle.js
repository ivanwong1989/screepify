const missionStates = require('managers_overseer_missions_board_missionStates');

function hashString(str) {
    const text = String(str || '');
    let h = 0;
    for (let i = 0; i < text.length; i++) {
        h = ((h << 5) - h) + text.charCodeAt(i);
        h |= 0;
    }
    return Math.abs(h);
}

function shouldRunEvery(interval, offset, tick) {
    const runInterval = Math.max(1, Number(interval) || 1);
    const t = Number.isFinite(tick) ? tick : Game.time;
    return (t + (offset || 0)) % runInterval === 0;
}

function getReconcileInterval(type) {
    switch (type) {
        case 'harvest': return 61;
        case 'build': return 17;
        case 'repair': return 17;
        case 'pickup': return 11;
        case 'logistics': return 9;
        case 'logisticsCoreV2': return 7;
        case 'logisticsSimpleCore': return 7;
        case 'logisticsMiningV2': return 11;
        case 'remoteHarvest': return 47;
        case 'remoteHaul': return 37;
        case 'scout': return 41;
        case 'mineral': return 61;
        case 'decongest': return 29;
        case 'tower': return 1;
        case 'towerPassive': return 7;
        case 'remoteBuild': return 100;
        case 'remoteRepair': return 23;
        case 'userRemoteReserve': return 7;
        case 'userRemoteClaim': return 11;
        case 'userRemoteMove2Flag': return 7;
        case 'labs': return 5;
        case 'userDismantle': return 7;
        case 'userTransfer': return 5;
        case 'reserve': return 73;
        case 'upgrade': return 13;
        default: return 31;
    }
}

function shouldRunReconcile(type, roomName, tick) {
    const interval = getReconcileInterval(type);
    const offset = hashString(`${type}:${roomName}`) % interval;
    return shouldRunEvery(interval, offset, tick);
}

function shouldRunScoped(scopeKey, roomName, interval, tick) {
    const runInterval = Math.max(1, Number(interval) || 1);
    const offset = hashString(`${scopeKey}:${roomName}`) % runInterval;
    return shouldRunEvery(runInterval, offset, tick);
}

function shouldRunDetector(type, roomName, tick) {
    return shouldRunReconcile(type, roomName, tick);
}

function getMissionUpdateInterval(mission) {
    if (!mission) return 11;
    if ((mission.priority || 0) >= 150) return 1;
    if (mission.class === 'service') {
        if (mission.type === 'harvest') return 21;
        if (mission.type === 'reserve') return 47;
        if (mission.type === 'upgrade') return 11;
        if (mission.type === 'tower') return 3;
        if (mission.type === 'logisticsCoreV2') return 7;
        if (mission.type === 'logisticsSimpleCore') return 7;
        if (mission.type === 'logisticsMiningV2') return 11;
        if (mission.type === 'remoteHarvest') return 53;
        if (mission.type === 'remoteHaul') return 31;
        if (mission.type === 'scout') return 37;
        if (mission.type === 'mineral') return 61;
        if (mission.type === 'decongest') return 29;
        return 31;
    }
    if (mission.class === 'finite') {
        return 9;
    }
    return 15;
}

function shouldCheckMission(mission, tick) {
    if (!mission || missionStates.TERMINAL_STATES.has(mission.state)) return false;
    // Finite missions represent short-lived contracts and should reconcile every tick
    // so completion/cancellation is reflected immediately.
    if (mission.class === 'finite') return true;
    const now = Number.isFinite(tick) ? tick : Game.time;
    const interval = getMissionUpdateInterval(mission);
    if (!Number.isFinite(mission.lastCheckedTick) || mission.lastCheckedTick <= 0) return true;
    return (now - mission.lastCheckedTick) >= interval;
}

module.exports = {
    shouldRunEvery,
    shouldRunScoped,
    getMissionUpdateInterval,
    shouldCheckMission,
    getReconcileInterval,
    shouldRunReconcile,
    shouldRunDetector,
};

