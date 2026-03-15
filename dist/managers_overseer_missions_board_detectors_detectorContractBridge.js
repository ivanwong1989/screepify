const missionKeys = require('managers_overseer_missions_board_missionKeys');

function cloneContract(contract) {
    if (!contract || typeof contract !== 'object') return null;
    return Object.assign({}, contract);
}

function upsertTypedMission(room, missionBoard, namespace, type, mapped, contract, runtimeCtx) {
    if (!room || !missionBoard || !namespace || !type || !mapped || !contract) return null;

    const contextPayload = Object.assign({}, mapped, {
        sponsorRoom: mapped.sponsorRoom || room.name,
        targetRoom: mapped.targetRoom || room.name,
        namespace,
        contract
    });
    const mission = missionBoard.createMission(type, contextPayload, runtimeCtx || null);
    if (!mission || !mission.id) return null;

    const existingMeta = mission.meta || {};
    const patchMeta = Object.assign({}, existingMeta, {
        namespace,
        contractType: contract.type || null,
        contractName: contract.name || null
    });
    if (mapped.userMissionId) patchMeta.userMissionId = mapped.userMissionId;

    missionBoard.patchMission(mission.id, {
        sponsorRoom: contextPayload.sponsorRoom,
        targetRoom: contextPayload.targetRoom,
        targetId: contract.targetId || contract.sourceId || mission.targetId || null,
        priority: Number.isFinite(contract.priority)
            ? contract.priority
            : (Number.isFinite(mission.priority) ? mission.priority : 0),
        meta: patchMeta,
        data: {
            contract: cloneContract(contract)
        },
        state: 'active',
        statusReason: null,
        lastCheckedTick: Game.time
    });

    return mission.id;
}

function upsertContractMission(room, missionBoard, namespace, contract, runtimeCtx) {
    if (!room || !missionBoard || !contract) return null;
    const key = missionKeys.makeContractKey(room.name, contract);
    if (!key) return null;

    const created = missionBoard.createMission('contract', {
        sponsorRoom: room.name,
        targetRoom: room.name,
        namespace,
        contract
    }, runtimeCtx || null);

    if (!created) return null;

    missionBoard.patchMission(key, {
        sponsorRoom: room.name,
        targetRoom: (contract.pos && contract.pos.roomName) || room.name,
        targetId: contract.targetId || contract.sourceId || null,
        priority: Number.isFinite(contract.priority) ? contract.priority : 0,
        meta: Object.assign({}, created.meta || {}, {
            namespace,
            contractType: contract.type || null,
            contractName: contract.name || null
        }),
        data: {
            contract: cloneContract(contract)
        },
        state: 'active',
        statusReason: null,
        updatedTick: Game.time,
        lastCheckedTick: Game.time
    });

    return key;
}

function reconcileNamespace(room, missionBoard, namespace, seenIds) {
    if (!room || !missionBoard || !namespace) return;
    const live = missionBoard.listLiveByRoom(room.name);
    const seen = seenIds || new Set();
    for (let i = 0; i < live.length; i++) {
        const mission = live[i];
        if (!mission || mission.type !== 'contract') continue;
        if (!mission.meta || mission.meta.namespace !== namespace) continue;
        if (seen.has(mission.id)) continue;
        missionBoard.markCancelled(mission.id, 'not_detected');
    }
}

function reconcileTypedNamespace(room, missionBoard, namespace, type, seenIds) {
    if (!room || !missionBoard || !namespace || !type) return;
    const live = missionBoard.listLiveByRoom(room.name);
    const seen = seenIds || new Set();
    for (let i = 0; i < live.length; i++) {
        const mission = live[i];
        if (!mission || mission.type !== type) continue;
        if (!mission.meta || mission.meta.namespace !== namespace) continue;
        if (seen.has(mission.id)) continue;
        missionBoard.markCancelled(mission.id, 'not_detected');
    }
}

function runGeneratorAsContracts({ room, intel, context, missionBoard, namespace, generate }) {
    if (!room || !intel || !missionBoard || typeof generate !== 'function') return;

    const missions = [];
    generate(room, intel, context || {}, missions);

    const seen = new Set();
    for (let i = 0; i < missions.length; i++) {
        const contract = missions[i];
        const id = upsertContractMission(room, missionBoard, namespace, contract, { room, intel, context });
        if (id) seen.add(id);
    }
    reconcileNamespace(room, missionBoard, namespace, seen);
}

function runGeneratorAsTyped({ room, intel, context, missionBoard, namespace, type, generate, mapContract }) {
    if (!room || !intel || !missionBoard || !namespace || !type || typeof generate !== 'function') return;
    const mapper = (typeof mapContract === 'function')
        ? mapContract
        : ((contract) => ({ sponsorRoom: room.name, targetRoom: room.name, contract }));

    const contracts = [];
    generate(room, intel, context || {}, contracts);

    const seen = new Set();
    for (let i = 0; i < contracts.length; i++) {
        const contract = contracts[i];
        if (!contract) continue;
        const mapped = mapper(contract, room, intel, context || {}) || null;
        if (!mapped) continue;
        const missionId = upsertTypedMission(
            room,
            missionBoard,
            namespace,
            type,
            mapped,
            contract,
            { room, intel, context }
        );
        if (missionId) seen.add(missionId);
    }
    reconcileTypedNamespace(room, missionBoard, namespace, type, seen);
    // Backward-compat cleanup: if this namespace previously used contract missions,
    // retire them now that it is migrated to a typed mission handler.
    reconcileNamespace(room, missionBoard, namespace, new Set());
}

module.exports = {
    upsertContractMission,
    reconcileNamespace,
    runGeneratorAsContracts,
    runGeneratorAsTyped
};
