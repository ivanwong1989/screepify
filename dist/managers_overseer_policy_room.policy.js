const constants = require('managers_overseer_policy_room.policy.constants');

function normalizeOrderMode(value) {
    if (typeof value !== 'string') return constants.ORDER_MODE.AUTO;
    const normalized = value.trim().toUpperCase();
    if (normalized === constants.ORDER_MODE.AUTO) return constants.ORDER_MODE.AUTO;
    return constants.ORDER_MODE.AUTO;
}

function deriveOrders(room) {
    const defaults = constants.DEFAULT_ORDERS;
    const ordersRoot = Memory && Memory.empire && Memory.empire.roomOrders
        ? Memory.empire.roomOrders
        : null;
    const raw = room && room.name && ordersRoot && ordersRoot[room.name] ? ordersRoot[room.name] : null;
    if (!raw || typeof raw !== 'object') {
        return {
            enabled: defaults.enabled,
            mode: defaults.mode
        };
    }
    return {
        enabled: raw.enabled === true,
        mode: normalizeOrderMode(raw.mode)
    };
}

function deriveRoomPolicy(room, intel, condition) {
    return {
        version: 2,
        phase: condition && condition.phase ? condition.phase : constants.PHASE.BOOTSTRAP,
        state: condition && condition.state ? condition.state : constants.STATE.RECOVER,
        orders: deriveOrders(room)
    };
}

module.exports = {
    deriveRoomPolicy
};
