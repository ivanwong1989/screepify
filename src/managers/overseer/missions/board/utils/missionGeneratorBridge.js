const missionKeys = require('managers_overseer_missions_board_missionKeys');

function cloneContract(contract) {
    if (!contract || typeof contract !== 'object') return null;
    return Object.assign({}, contract);
}

function shallowEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;

    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;

    for (let i = 0; i < aKeys.length; i++) {
        const key = aKeys[i];
        if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
        if (a[key] !== b[key]) return false;
    }
    return true;
}

function normalizeMeta(meta) {
    return meta ? Object.assign({}, meta) : {};
}

function shouldPatchMission(mission, patch) {
    if (!mission || !patch) return true;
    if (patch.sponsorRoom !== undefined && patch.sponsorRoom !== mission.sponsorRoom) return true;
    if (patch.targetRoom !== undefined && patch.targetRoom !== mission.targetRoom) return true;
    if (patch.targetId !== undefined && patch.targetId !== mission.targetId) return true;
    if (patch.priority !== undefined && patch.priority !== mission.priority) return true;
    if (patch.state !== undefined && patch.state !== mission.state) return true;

    const currentReason = mission.statusReason || null;
    const nextReason = patch.statusReason || null;
    if (patch.statusReason !== undefined && nextReason !== currentReason) return true;

    const currentMeta = normalizeMeta(mission.meta);
    const nextMeta = normalizeMeta(patch.meta);
    if (!shallowEqual(currentMeta, nextMeta)) return true;

    const currentContract = mission.data && mission.data.contract ? mission.data.contract : null;
    const nextContract = patch.data && patch.data.contract ? patch.data.contract : null;
    if (!shallowEqual(currentContract, nextContract)) return true;

    return false;
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

    const patch = {
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
    };

    if (shouldPatchMission(mission, patch)) {
        missionBoard.patchMission(mission.id, patch);
    } else if (mission.state !== 'active' || mission.statusReason) {
        missionBoard.setState(mission.id, 'active', null);
    }

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

    const patch = {
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
        lastCheckedTick: Game.time
    };

    if (shouldPatchMission(created, patch)) {
        missionBoard.patchMission(key, patch);
    } else if (created.state !== 'active' || created.statusReason) {
        missionBoard.setState(key, 'active', null);
    }

    return key;
}

function getNamespaceMeta(missionBoard, roomName, namespace) {
    if (!missionBoard || !roomName || !namespace || typeof missionBoard.ensureMemory !== 'function') return null;
    const board = missionBoard.ensureMemory();
    if (!board.namespaceMeta || typeof board.namespaceMeta !== 'object') board.namespaceMeta = {};
    if (!board.namespaceMeta[roomName] || typeof board.namespaceMeta[roomName] !== 'object') {
        board.namespaceMeta[roomName] = Object.create(null);
    }
    if (!board.namespaceMeta[roomName][namespace] || typeof board.namespaceMeta[roomName][namespace] !== 'object') {
        board.namespaceMeta[roomName][namespace] = Object.create(null);
    }
    return board.namespaceMeta[roomName][namespace];
}

function reconcileNamespace(room, missionBoard, namespace, seenIds) {
    if (!room || !missionBoard || !namespace) return;
    const live = missionBoard.listLiveByNamespace
        ? missionBoard.listLiveByNamespace(room.name, namespace, 'contract')
        : [];
    const seen = seenIds || new Set();
    for (let i = 0; i < live.length; i++) {
        const mission = live[i];
        if (!mission || seen.has(mission.id)) continue;
        missionBoard.markCancelled(mission.id, 'not_detected');
    }
}

function reconcileTypedNamespace(room, missionBoard, namespace, type, seenIds) {
    if (!room || !missionBoard || !namespace || !type) return;
    const live = missionBoard.listLiveByNamespace
        ? missionBoard.listLiveByNamespace(room.name, namespace, type)
        : [];
    const seen = seenIds || new Set();
    for (let i = 0; i < live.length; i++) {
        const mission = live[i];
        if (!mission || seen.has(mission.id)) continue;
        missionBoard.markCancelled(mission.id, 'not_detected');
    }
}

function cleanupLegacyContractsIfNeeded(room, missionBoard, namespace) {
    if (!room || !missionBoard || !namespace) return;
    const meta = getNamespaceMeta(missionBoard, room.name, namespace);
    if (meta && meta.legacyContractsCleaned) return;

    const legacyContracts = missionBoard.listLiveByNamespace
        ? missionBoard.listLiveByNamespace(room.name, namespace, 'contract')
        : [];
    if (!legacyContracts || legacyContracts.length <= 0) {
        if (meta) meta.legacyContractsCleaned = true;
        return;
    }

    for (let i = 0; i < legacyContracts.length; i++) {
        const mission = legacyContracts[i];
        if (!mission) continue;
        missionBoard.markCancelled(mission.id, 'legacy_contract_cleanup');
    }
    if (meta) meta.legacyContractsCleaned = true;
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
    // Backward-compat cleanup is one-shot now; do not rescan the entire room every reconcile tick forever.
    cleanupLegacyContractsIfNeeded(room, missionBoard, namespace);
}

module.exports = {
    upsertTypedMission,
    upsertContractMission,
    reconcileTypedNamespace,
    reconcileNamespace,
    runGeneratorAsContracts,
    runGeneratorAsTyped
};
