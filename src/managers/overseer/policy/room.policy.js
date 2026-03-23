const constants = require('managers_overseer_policy_room.policy.constants');

function derivePosture(condition, directive, reasons) {
    if (condition.status === constants.STATUS.EMERGENCY) {
        reasons.push('status=EMERGENCY -> posture SURVIVE');
        return constants.POSTURE.SURVIVE;
    }
    if (condition.status === constants.STATUS.RECOVERING) {
        reasons.push('status=RECOVERING -> posture RECOVER');
        return constants.POSTURE.RECOVER;
    }

    const economyState = condition.legacy && condition.legacy.economyState;
    if (economyState === 'STOCKPILING') {
        reasons.push('legacy economyState=STOCKPILING -> posture STOCKPILE');
        return constants.POSTURE.STOCKPILE;
    }

    if (directive.mode === constants.DIRECTIVE_MODE.HOLD) {
        reasons.push('directive.mode=HOLD -> posture STABILIZE');
        return constants.POSTURE.STABILIZE;
    }

    if (directive.mode === constants.DIRECTIVE_MODE.DONOR || directive.transferBias === constants.DIRECTIVE_TRANSFER_BIAS.EXPORT) {
        reasons.push('directive donor/export hint -> posture EXPORT');
        return constants.POSTURE.EXPORT;
    }

    reasons.push('default posture GROW');
    return constants.POSTURE.GROW;
}

function deriveEconomyMode(condition, posture, reasons) {
    if (condition.status === constants.STATUS.EMERGENCY) {
        reasons.push('status=EMERGENCY -> economyMode BOOTSTRAP');
        return constants.ECONOMY_MODE.BOOTSTRAP;
    }
    if (condition.status === constants.STATUS.RECOVERING) {
        reasons.push('status=RECOVERING -> economyMode BUFFER_BUILD');
        return constants.ECONOMY_MODE.BUFFER_BUILD;
    }
    if (posture === constants.POSTURE.STOCKPILE) return constants.ECONOMY_MODE.BUFFER_BUILD;
    if (posture === constants.POSTURE.EXPORT) return constants.ECONOMY_MODE.SURPLUS_ENERGY;
    return constants.ECONOMY_MODE.LOCAL_GROWTH;
}

function deriveMissionGates(condition, directive, reasons) {
    const emergency = condition.status === constants.STATUS.EMERGENCY;
    const recovering = condition.status === constants.STATUS.RECOVERING;
    const phase = condition.phase || constants.PHASE.BOOTSTRAP;
    const remotePhaseReady = phase === constants.PHASE.REMOTE_READY || phase === constants.PHASE.MATURE;
    const remotesBlocked = emergency || recovering || !remotePhaseReady || directive.remoteBias === constants.DIRECTIVE_REMOTE_BIAS.DEFER;
    const buildBlocked = emergency;
    const upgradeBlocked = emergency;

    if (emergency) reasons.push('survival invariant (EMERGENCY) -> disable upgrade/build/scout/remotes');
    if (recovering && !emergency) reasons.push('status=RECOVERING -> disable remote mission families');
    if (!remotePhaseReady) reasons.push(`phase=${phase} not remote-ready -> disable remote mission families`);
    if (directive.remoteBias === constants.DIRECTIVE_REMOTE_BIAS.DEFER && !emergency) {
        reasons.push('directive.remoteBias=DEFER -> disable remote mission families');
    }

    return {
        simpleHarvest: true,
        harvest: true,
        logisticsSimpleCore: true,
        logisticsSimpleMining: true,
        logisticsCoreV2: true,
        logisticsMiningV2: true,
        upgrade: !upgradeBlocked,
        build: !buildBlocked,
        repair: true,
        fortify: true,
        scout: !emergency,
        remoteBuild: !remotesBlocked,
        remoteHarvest: !remotesBlocked,
        remoteHaul: !remotesBlocked,
        mineral: !emergency
    };
}

function derivePriorities(condition, directive, missionGates) {
    const emergency = condition.status === constants.STATUS.EMERGENCY;
    const remoteOff = !missionGates.remoteHarvest || !missionGates.remoteHaul;
    return {
        upgradeIntensity: emergency || directive.upgradeBias === constants.DIRECTIVE_BIAS.DEFER
            ? constants.INTENSITY.LOW
            : constants.INTENSITY.NORMAL,
        buildIntensity: emergency || directive.buildBias === constants.DIRECTIVE_BIAS.DEFER
            ? constants.INTENSITY.LOW
            : constants.INTENSITY.NORMAL,
        repairIntensity: directive.repairBias === constants.DIRECTIVE_BIAS.PUSH
            ? constants.INTENSITY.HIGH
            : constants.INTENSITY.NORMAL,
        fortifyIntensity: emergency ? constants.INTENSITY.LOW : constants.INTENSITY.NORMAL,
        remoteIntensity: remoteOff ? constants.REMOTE_INTENSITY.OFF : constants.REMOTE_INTENSITY.NORMAL,
        exportIntensity: constants.EXPORT_INTENSITY.OFF
    };
}

function deriveEnergyPolicy(condition, posture, directive, reasons) {
    const emergency = condition.status === constants.STATUS.EMERGENCY;
    const recovering = condition.status === constants.STATUS.RECOVERING;
    const hasStorage = !!(condition.facts && condition.facts.hasStorage);

    const allowExport = !emergency && !recovering
        && (posture === constants.POSTURE.EXPORT || directive.transferBias === constants.DIRECTIVE_TRANSFER_BIAS.EXPORT);
    const requestImport = emergency || directive.mode === constants.DIRECTIVE_MODE.RECIPIENT;
    const preferStockpile = posture === constants.POSTURE.STOCKPILE || emergency || recovering;
    const preferUpgrade = posture === constants.POSTURE.GROW && !emergency;
    const targetReserve = hasStorage ? 50000 : 0;

    if (requestImport) reasons.push('recipient/emergency -> requestImport true');
    if (allowExport) reasons.push('export posture/directive and safe -> allowExport true');

    return {
        allowExport,
        requestImport,
        preferStockpile,
        preferUpgrade,
        targetReserve
    };
}

function deriveRoomPolicy(room, intel, condition, directive) {
    const reasons = [];
    const posture = derivePosture(condition, directive, reasons);
    const economyMode = deriveEconomyMode(condition, posture, reasons);
    const missionGates = deriveMissionGates(condition, directive, reasons);
    const priorities = derivePriorities(condition, directive, missionGates);
    const energy = deriveEnergyPolicy(condition, posture, directive, reasons);

    return {
        version: 1,
        roomName: room ? room.name : null,
        phase: condition.phase,
        status: condition.status,
        posture,
        economyMode,
        directive,
        missionGates,
        priorities,
        energy,
        legacy: {
            opState: condition.legacy && condition.legacy.opState ? condition.legacy.opState : 'NORMAL',
            economyState: condition.legacy && condition.legacy.economyState ? condition.legacy.economyState : 'STOCKPILING'
        },
        reasons
    };
}

module.exports = {
    deriveRoomPolicy
};
