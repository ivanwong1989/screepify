const constants = require('managers_overseer_policy_room.policy.constants');

function derivePhase(room, intel) {
    const controller = room && room.controller ? room.controller : null;
    const myRoom = !!(controller && controller.my);
    if (!myRoom) return constants.PHASE.BOOTSTRAP;

    const structures = intel && intel.structures ? intel.structures : {};
    const spawns = structures[STRUCTURE_SPAWN] || [];
    const links = structures[STRUCTURE_LINK] || [];
    const labs = structures[STRUCTURE_LAB] || [];
    const sources = intel && Array.isArray(intel.sources) ? intel.sources : [];
    const sourceCount = sources.length;
    const sourceContainerCount = sources.filter(s => !!(s && s.containerId)).length;
    const sourceLinkCount = sources.filter(s => !!(s && s.linkId)).length;
    const hasAnySourceContainer = sourceContainerCount > 0;
    const hasMajorSourceContainerCoverage = sourceCount > 0 && sourceContainerCount >= Math.max(1, Math.ceil(sourceCount * 0.75));
    const miningContainerIds = new Set(sources.map(s => s && s.containerId).filter(Boolean));
    const allContainers = structures[STRUCTURE_CONTAINER] || [];
    const nonMiningContainers = allContainers.filter(c => c && !miningContainerIds.has(c.id));
    const hasStorage = !!(room && room.storage);
    const hasTerminal = !!(room && room.terminal);
    const hasControllerLink = !!(controller && links.some(link => link && link.pos && link.pos.getRangeTo(controller) <= 3));
    const linkInfrastructureReady = links.length >= 2 && (sourceLinkCount > 0 || hasControllerLink);

    if (!spawns.length || sourceCount <= 0) return constants.PHASE.BOOTSTRAP;
    if (labs.length > 0) return constants.PHASE.LABS;
    if (hasTerminal) return constants.PHASE.TERMINAL;
    if (hasStorage && linkInfrastructureReady) return constants.PHASE.LINKS;
    if (hasStorage) return constants.PHASE.STORAGE;
    if (hasMajorSourceContainerCoverage && nonMiningContainers.length > 0) return constants.PHASE.BASIC_INFRA;
    if (hasAnySourceContainer || nonMiningContainers.length > 0) return constants.PHASE.EARLY;
    return constants.PHASE.BOOTSTRAP;
}

function countRoles(myCreeps) {
    const counts = {
        miner: 0,
        simpleMiner: 0,
        hauler: 0,
        simpleHaulerCore: 0,
        simpleMiningHauler: 0
    };
    for (let i = 0; i < myCreeps.length; i++) {
        const creep = myCreeps[i];
        const role = creep && creep.memory ? creep.memory.role : null;
        if (role === 'miner') counts.miner++;
        else if (role === 'simple_miner') counts.simpleMiner++;
        else if (role === 'hauler' || role === 'coreLaneHauler' || role === 'miningLaneHauler') counts.hauler++;
        else if (role === 'simpleHaulerCore') counts.simpleHaulerCore++;
        else if (role === 'simpleMiningHauler') counts.simpleMiningHauler++;
    }
    return counts;
}

function getStockpileTargetByRcl(rcl) {
    const targets = constants.STOCKPILE_STORAGE_ENERGY_TARGET_BY_RCL || {};
    if (Number.isFinite(rcl) && Number.isFinite(targets[rcl])) return targets[rcl];
    return 0;
}

function deriveState(room, intel, phase, reasons) {
    const myCreeps = intel && Array.isArray(intel.myCreeps) ? intel.myCreeps : [];
    const sources = intel && Array.isArray(intel.sources) ? intel.sources : [];
    const energyAvailable = intel && Number.isFinite(intel.energyAvailable) ? intel.energyAvailable : 0;
    const energyCapacityAvailable = intel && Number.isFinite(intel.energyCapacityAvailable) ? intel.energyCapacityAvailable : 0;
    const storageEnergy = intel && Number.isFinite(intel.storageEnergy) ? intel.storageEnergy : 0;
    const controller = room && room.controller ? room.controller : null;
    const rcl = controller && Number.isFinite(controller.level) ? controller.level : 0;
    const stockpileTarget = getStockpileTargetByRcl(rcl);
    const hostiles = intel && Array.isArray(intel.hostiles) ? intel.hostiles : [];
    const combatState = room && room.memory && room.memory.admiral ? room.memory.admiral.state : null;

    if (combatState === 'SIEGE') {
        reasons.push('combat=SIEGE -> state SIEGE');
        return constants.STATE.SIEGE;
    }
    if (combatState === 'DEFEND' || hostiles.length > 0) {
        reasons.push('combat threat present -> state DEFENSIVE');
        return constants.STATE.DEFENSIVE;
    }

    const roleCounts = countRoles(myCreeps);
    const minerCount = roleCounts.miner + roleCounts.simpleMiner;
    const haulerCount = roleCounts.hauler + roleCounts.simpleHaulerCore + roleCounts.simpleMiningHauler;
    const pop = myCreeps.length;
    const spawnEnergyLow = energyAvailable < Math.max(250, Math.floor(energyCapacityAvailable * 0.35));

    if (pop <= 0) {
        reasons.push('population=0 -> state CRITICAL');
        return constants.STATE.CRITICAL;
    }
    if (sources.length > 0 && minerCount <= 0) {
        reasons.push('no miners -> state CRITICAL');
        return constants.STATE.CRITICAL;
    }
    if (energyAvailable < 300 && pop < 2) {
        reasons.push('very low spawn energy + low pop -> state CRITICAL');
        return constants.STATE.CRITICAL;
    }

    if (pop <= 2 || spawnEnergyLow || haulerCount <= 0 || phase === constants.PHASE.BOOTSTRAP) {
        reasons.push('workforce/energy weak -> state RECOVER');
        return constants.STATE.RECOVER;
    }

    if (room && room.storage && storageEnergy < stockpileTarget) {
        reasons.push(`storage below stockpile target (${storageEnergy}/${stockpileTarget}) -> state STOCKPILE`);
        return constants.STATE.STOCKPILE;
    }

    reasons.push('default healthy -> state GROW');
    return constants.STATE.GROW;
}

function deriveRoomCondition(room, intel, context) {
    const reasons = [];
    const controller = room && room.controller ? room.controller : null;
    const myCreepCount = intel && Array.isArray(intel.myCreeps) ? intel.myCreeps.length : 0;
    const energyAvailable = intel && Number.isFinite(intel.energyAvailable) ? intel.energyAvailable : 0;
    const energyCapacityAvailable = intel && Number.isFinite(intel.energyCapacityAvailable) ? intel.energyCapacityAvailable : 0;
    const storageEnergy = intel && Number.isFinite(intel.storageEnergy) ? intel.storageEnergy : 0;
    const phase = derivePhase(room, intel);
    const state = deriveState(room, intel, phase, reasons);

    return {
        version: 2,
        roomName: room ? room.name : null,
        phase,
        state,
        facts: {
            rcl: controller && Number.isFinite(controller.level) ? controller.level : 0,
            hasStorage: !!(room && room.storage),
            hasTerminal: !!(room && room.terminal),
            linkCount: intel && intel.structures && Array.isArray(intel.structures[STRUCTURE_LINK])
                ? intel.structures[STRUCTURE_LINK].length
                : 0,
            labCount: intel && intel.structures && Array.isArray(intel.structures[STRUCTURE_LAB])
                ? intel.structures[STRUCTURE_LAB].length
                : 0,
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
    deriveRoomCondition
};
