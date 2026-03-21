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

const MISSION_REFRESH_POLICY = Object.freeze({
    harvest: { interval: 21 },
    simpleHarvest: { interval: 31 },
    build: { interval: 17 },
    repair: { interval: 17 },
    logisticsCoreV2: { interval: 7 },
    logisticsSimpleCore: { interval: 7 },
    logisticsSimpleMining: { interval: 11 },
    logisticsMiningV2: { interval: 11 },
    remoteHarvest: { interval: 47 },
    remoteHaul: { interval: 31 },
    scout: { interval: 37 },
    mineral: { interval: 61 },
    tower: { interval: 1 },
    towerPassive: { interval: 7 },
    remoteBuild: { interval: 100 },
    userRemoteMove2Flag: { interval: 7 },
    upgrade: { interval: 11 },
    default: { interval: 31 }
});

function getMissionRefreshInterval(type) {
    const policy = MISSION_REFRESH_POLICY[type] || MISSION_REFRESH_POLICY.default;
    return Math.max(1, Number(policy && policy.interval) || 1);
}

function shouldRunMissionRefresh(type, roomName, tick) {
    const interval = getMissionRefreshInterval(type);
    const offset = hashString(`${type}:${roomName}`) % interval;
    return shouldRunEvery(interval, offset, tick);
}

module.exports = {
    MISSION_REFRESH_POLICY,
    shouldRunEvery,
    getMissionRefreshInterval,
    shouldRunMissionRefresh,
};
