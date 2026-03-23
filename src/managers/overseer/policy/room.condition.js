const constants = require('managers_overseer_policy_room.policy.constants');

function derivePhase(room) {
    const controller = room && room.controller ? room.controller : null;
    const rcl = controller && Number.isFinite(controller.level) ? controller.level : 0;
    const hasStorage = !!(room && room.storage);
    const hasTerminal = !!(room && room.terminal);

    if (!controller || !controller.my || rcl <= 1) return constants.PHASE.BOOTSTRAP;
    if (!hasStorage && rcl <= 3) return constants.PHASE.EARLY_LOCAL;
    if (!hasStorage) return constants.PHASE.LOCAL_INFRA;
    if (rcl < 6) return constants.PHASE.STORAGE_CORE;
    if (!hasTerminal) return constants.PHASE.REMOTE_READY;
    return constants.PHASE.MATURE;
}

function deriveLegacyOpState(room, intel, reasons) {
    const myCreeps = (intel && Array.isArray(intel.myCreeps)) ? intel.myCreeps : [];
    const sources = (intel && Array.isArray(intel.sources)) ? intel.sources : [];
    const energyAvailable = (intel && Number.isFinite(intel.energyAvailable)) ? intel.energyAvailable : 0;

    if (myCreeps.length === 0) {
        if (Array.isArray(reasons)) reasons.push('legacy opState: EMERGENCY (zero population)');
        return 'EMERGENCY';
    }
    if (energyAvailable < 300 && myCreeps.length < 2) {
        if (Array.isArray(reasons)) reasons.push(`legacy opState: EMERGENCY (energy=${energyAvailable}, pop=${myCreeps.length})`);
        return 'EMERGENCY';
    }
    const miners = myCreeps.filter(c => c && c.memory && c.memory.role === 'miner');
    if (miners.length === 0 && sources.length > 0) {
        if (Array.isArray(reasons)) reasons.push('legacy opState: EMERGENCY (no miners)');
        return 'EMERGENCY';
    }
    return 'NORMAL';
}

function ensureEconomyFlow(room, totalStored) {
    if (!room.memory.overseer) room.memory.overseer = {};
    if (!room.memory.overseer.economyFlow) {
        room.memory.overseer.economyFlow = {
            avg: 0,
            longAvg: 0,
            lastSampleTotal: totalStored,
            lastSampleTick: Game.time,
            lastPerTick: 0,
            lastDelta: 0,
            lastDt: 0,
            lastLogTotal: totalStored,
            lastLogTick: Game.time
        };
    }
    const flow = room.memory.overseer.economyFlow;
    if (flow.lastSampleTotal === undefined) flow.lastSampleTotal = totalStored;
    if (flow.lastSampleTick === undefined) flow.lastSampleTick = Game.time;
    if (flow.lastPerTick === undefined) flow.lastPerTick = 0;
    if (flow.lastDelta === undefined) flow.lastDelta = 0;
    if (flow.lastDt === undefined) flow.lastDt = 0;
    if (flow.lastLogTotal === undefined) flow.lastLogTotal = totalStored;
    if (flow.lastLogTick === undefined) flow.lastLogTick = Game.time;
    if (flow.avg === undefined || flow.avg === null || Number.isNaN(flow.avg)) flow.avg = 0;
    if (flow.longAvg === undefined || flow.longAvg === null || Number.isNaN(flow.longAvg)) flow.longAvg = flow.avg;
    room.memory.overseer.economyFlow = flow;
    return flow;
}

function deriveLegacyEconomyState(room, intel, reasons) {
    if (!room.memory.overseer) room.memory.overseer = {};
    let current = (room.memory.overseer && room.memory.overseer.economyState) || 'STOCKPILING';

    const sources = (intel && Array.isArray(intel.sources)) ? intel.sources : [];
    const structures = (intel && intel.structures) ? intel.structures : {};
    const storageEnergy = (intel && Number.isFinite(intel.storageEnergy)) ? intel.storageEnergy : 0;
    const storageCapacity = (intel && Number.isFinite(intel.storageCapacity)) ? intel.storageCapacity : 0;

    const miningContainerIds = new Set(sources.map(s => s && s.containerId).filter(id => !!id));
    const allContainers = structures[STRUCTURE_CONTAINER] || [];
    const logisticsContainers = allContainers.filter(c => !miningContainerIds.has(c.id));

    const logisticsEnergy = logisticsContainers.reduce((sum, c) => sum + (c.store[RESOURCE_ENERGY] || 0), 0);
    const logisticsCapacity = logisticsContainers.reduce((sum, c) => sum + c.store.getCapacity(RESOURCE_ENERGY), 0);

    const totalStored = logisticsEnergy + storageEnergy;
    const totalCapacity = logisticsCapacity + storageCapacity;

    const SAMPLE_TICKS = 20;
    const ALPHA = 0.02;

    const flow = ensureEconomyFlow(room, totalStored);

    const since = Game.time - (flow.lastSampleTick || Game.time);
    if (since >= SAMPLE_TICKS) {
        const dt = Math.max(1, Game.time - (flow.lastSampleTick || Game.time));
        const delta = totalStored - (flow.lastSampleTotal || totalStored);
        const perTick = delta / dt;

        flow.lastPerTick = perTick;
        flow.lastDelta = delta;
        flow.lastDt = dt;
        flow.avg = (flow.avg === undefined || flow.avg === null)
            ? perTick
            : ((flow.avg * (1 - ALPHA)) + (perTick * ALPHA));
        flow.longAvg = flow.avg;
        flow.lastSampleTotal = totalStored;
        flow.lastSampleTick = Game.time;
        room.memory.overseer.economyFlow = flow;
    }

    if (Game.time % 50 === 0 && flow._lastLoggedAt !== Game.time) {
        flow._lastLoggedAt = Game.time;
        const logDt = Math.max(1, Game.time - (flow.lastLogTick || Game.time));
        const logDelta = totalStored - (flow.lastLogTotal || totalStored);
        const logPerTick = logDelta / logDt;
        flow.lastLogTotal = totalStored;
        flow.lastLogTick = Game.time;
        room.memory.overseer.economyFlow = flow;

        debug(
            'overseer',
            `[Overseer] ${room.name} Flow: total=${totalStored} ` +
            `sampleDt=${flow.lastDt} sampleDelta=${flow.lastDelta} samplePerTick=${(flow.lastPerTick || 0).toFixed(2)} ` +
            `windowDt=${logDt} windowDelta=${logDelta} windowPerTick=${logPerTick.toFixed(2)} ` +
            `avg=${(flow.avg || 0).toFixed(2)}`
        );
    }

    const override = room.memory.overseer.economyOverride;
    const normalized = override ? ('' + override).trim().toUpperCase() : '';
    if (normalized === 'UPGRADING' || normalized === 'STOCKPILING') {
        if (Array.isArray(reasons)) reasons.push(`legacy economy override -> ${normalized}`);
        return normalized;
    }

    if (totalCapacity < 500) {
        if (Array.isArray(reasons)) reasons.push('legacy economy: low logistics capacity -> UPGRADING');
        return 'UPGRADING';
    }

    if (room.storage) {
        const rcl = (room.controller && room.controller.level) ? room.controller.level : 1;
        const rclThresholds = {
            1: { start: 10000, stop: 5000 },
            2: { start: 20000, stop: 10000 },
            3: { start: 30000, stop: 15000 },
            4: { start: 40000, stop: 20000 },
            5: { start: 100000, stop: 80000 },
            6: { start: 200000, stop: 150000 },
            7: { start: 300000, stop: 250000 },
            8: { start: 350000, stop: 300000 }
        };
        const threshold = rclThresholds[rcl] || rclThresholds[5];
        const UPGRADE_START = threshold.start;
        const UPGRADE_STOP = threshold.stop;
        const STORAGE_FILL_UPGRADE_START = 0.90;
        const STORAGE_FILL_UPGRADE_STOP = 0.80;
        const storageUsed = room.storage.store.getUsedCapacity();
        const storageCap = room.storage.store.getCapacity() || 1;
        const storageFillRatio = storageUsed / storageCap;

        if (current === 'STOCKPILING' && (totalStored >= UPGRADE_START || storageFillRatio >= STORAGE_FILL_UPGRADE_START)) {
            current = 'UPGRADING';
        } else if (current === 'UPGRADING' && totalStored <= UPGRADE_STOP && storageFillRatio <= STORAGE_FILL_UPGRADE_STOP) {
            current = 'STOCKPILING';
        }
    } else {
        current = 'UPGRADING';
    }

    if (Array.isArray(reasons)) reasons.push(`legacy economy hysteresis -> ${current}`);
    return current;
}

function deriveRoomCondition(room, intel, context) {
    const reasons = [];
    const controller = room && room.controller ? room.controller : null;
    const opState = context && context.opState
        ? context.opState
        : deriveLegacyOpState(room, intel, reasons);
    const economyState = context && context.economyState
        ? context.economyState
        : deriveLegacyEconomyState(room, intel, reasons);

    const myCreepCount = intel && Array.isArray(intel.myCreeps) ? intel.myCreeps.length : 0;
    const energyAvailable = intel && Number.isFinite(intel.energyAvailable) ? intel.energyAvailable : 0;
    const energyCapacityAvailable = intel && Number.isFinite(intel.energyCapacityAvailable) ? intel.energyCapacityAvailable : 0;
    const storageEnergy = intel && Number.isFinite(intel.storageEnergy) ? intel.storageEnergy : 0;
    const energyLow = energyAvailable < Math.max(250, Math.floor(energyCapacityAvailable * 0.45));

    let status = constants.STATUS.NORMAL;
    if (opState === 'EMERGENCY') status = constants.STATUS.EMERGENCY;
    else if (myCreepCount <= 2 || energyLow) status = constants.STATUS.RECOVERING;
    else if (economyState === 'UPGRADING' && storageEnergy >= 200000) status = constants.STATUS.SURPLUS;

    reasons.push(`status derived as ${status} from op=${opState} economy=${economyState}`);

    const phase = derivePhase(room);
    reasons.push(`phase derived as ${phase}`);

    return {
        version: 1,
        roomName: room ? room.name : null,
        phase,
        status,
        legacy: {
            opState,
            economyState
        },
        facts: {
            rcl: controller && Number.isFinite(controller.level) ? controller.level : 0,
            hasStorage: !!(room && room.storage),
            hasTerminal: !!(room && room.terminal),
            myCreepCount,
            sourceCount: intel && Array.isArray(intel.sources) ? intel.sources.length : 0,
            energyAvailable,
            energyCapacityAvailable,
            storageEnergy,
            containerEnergy: intel && Number.isFinite(intel.containerEnergy) ? intel.containerEnergy : 0
        },
        reasons
    };
}

module.exports = {
    deriveLegacyOpState,
    deriveLegacyEconomyState,
    deriveRoomCondition
};
