function makeHarvestKey(roomName, sourceId) {
    return `harvest:${roomName}:${sourceId}`;
}

function makeBuildKey(roomName, siteId) {
    return `build:${roomName}:${siteId}`;
}

function makePickupKey(roomName, x, y, resourceType) {
    return `pickup:${roomName}:${resourceType}:${x}:${y}`;
}

function makeRepairKey(roomName, structureType, x, y) {
    return `repair:${roomName}:${structureType}:${x}:${y}`;
}

function makeRepairTargetKey(roomName, targetId, mode) {
    const kind = mode === 'fortify' ? 'fortify' : 'repair';
    return `${kind}:${roomName}:${targetId}`;
}

function makeUpgradeKey(roomName, variant) {
    const v = variant || 'primary';
    return `upgrade:${roomName}:${v}:controller`;
}

function makeRemoteHarvestKey(homeRoomName, remoteRoomName, sourceId) {
    return `remoteHarvest:${homeRoomName}:${remoteRoomName}:${sourceId}`;
}

function makeRemoteHaulKey(homeRoomName, remoteRoomName, sourceId) {
    return `remoteHaul:${homeRoomName}:${remoteRoomName}:${sourceId}`;
}

function makeRemoteBuildKey(homeRoomName, remoteRoomName, siteId) {
    return `remoteBuild:${homeRoomName}:${remoteRoomName}:${siteId}`;
}

function makeScoutKey(roomName) {
    return `scout:${roomName}`;
}

function makeMineralKey(roomName, mineralId) {
    return `mineral:${roomName}:${mineralId}`;
}

function makeContractKey(roomName, mission) {
    if (!mission) return null;
    const type = mission.type || 'unknown';
    const name = mission.name || null;
    if (name) return `contract:${roomName}:${type}:${name}`;

    if (mission.targetId) return `contract:${roomName}:${type}:target:${mission.targetId}`;
    if (mission.sourceId) return `contract:${roomName}:${type}:source:${mission.sourceId}`;
    if (mission.pos && Number.isFinite(mission.pos.x) && Number.isFinite(mission.pos.y) && mission.pos.roomName) {
        return `contract:${roomName}:${type}:pos:${mission.pos.roomName}:${mission.pos.x}:${mission.pos.y}`;
    }
    return `contract:${roomName}:${type}:anon`;
}

function makeUserMissionKey(roomName, missionType, userMissionId, fallback) {
    const type = missionType || 'userMission';
    const id = userMissionId || fallback || 'anon';
    return `${type}:${roomName}:${id}`;
}

module.exports = {
    makeHarvestKey,
    makeBuildKey,
    makePickupKey,
    makeRepairKey,
    makeRepairTargetKey,
    makeUpgradeKey,
    makeRemoteHarvestKey,
    makeRemoteHaulKey,
    makeRemoteBuildKey,
    makeScoutKey,
    makeMineralKey,
    makeContractKey,
    makeUserMissionKey
};

