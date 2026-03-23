const constants = require('managers_overseer_policy_room.policy.constants');

function normalizeEnum(value, allowed, fallback) {
    if (typeof value !== 'string') return fallback;
    const normalized = value.trim().toUpperCase();
    return allowed[normalized] || fallback;
}

function normalizeRoomDirective(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        mode: normalizeEnum(source.mode, constants.DIRECTIVE_MODE, constants.DEFAULT_DIRECTIVE.mode),
        energyPosture: normalizeEnum(source.energyPosture, constants.DIRECTIVE_ENERGY_POSTURE, constants.DEFAULT_DIRECTIVE.energyPosture),
        upgradeBias: normalizeEnum(source.upgradeBias, constants.DIRECTIVE_BIAS, constants.DEFAULT_DIRECTIVE.upgradeBias),
        buildBias: normalizeEnum(source.buildBias, constants.DIRECTIVE_BIAS, constants.DEFAULT_DIRECTIVE.buildBias),
        repairBias: normalizeEnum(source.repairBias, constants.DIRECTIVE_BIAS, constants.DEFAULT_DIRECTIVE.repairBias),
        remoteBias: normalizeEnum(source.remoteBias, constants.DIRECTIVE_REMOTE_BIAS, constants.DEFAULT_DIRECTIVE.remoteBias),
        transferBias: normalizeEnum(source.transferBias, constants.DIRECTIVE_TRANSFER_BIAS, constants.DEFAULT_DIRECTIVE.transferBias)
    };
}

function getEmpireRoomDirective(roomName) {
    if (!Memory.empire) Memory.empire = {};
    if (!Memory.empire.roomDirectives) Memory.empire.roomDirectives = {};
    const raw = Memory.empire.roomDirectives[roomName] || null;
    return normalizeRoomDirective(raw);
}

module.exports = {
    getEmpireRoomDirective,
    normalizeRoomDirective
};
