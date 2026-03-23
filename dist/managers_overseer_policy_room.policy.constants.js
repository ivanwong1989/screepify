const PHASE = Object.freeze({
    BOOTSTRAP: 'BOOTSTRAP',
    EARLY: 'EARLY',
    BASIC_INFRA: 'BASIC_INFRA',
    STORAGE: 'STORAGE',
    LINKS: 'LINKS',
    TERMINAL: 'TERMINAL',
    LABS: 'LABS'
});

const STATE = Object.freeze({
    CRITICAL: 'CRITICAL',
    RECOVER: 'RECOVER',
    GROW: 'GROW',
    STOCKPILE: 'STOCKPILE',
    DEFENSIVE: 'DEFENSIVE',
    SIEGE: 'SIEGE'
});

const ORDER_MODE = Object.freeze({
    AUTO: 'AUTO'
});

const DEFAULT_ORDERS = Object.freeze({
    enabled: false,
    mode: ORDER_MODE.AUTO
});

const STOCKPILE_STORAGE_ENERGY_TARGET_BY_RCL = Object.freeze({
    1: 0,
    2: 0,
    3: 20000,
    4: 50000,
    5: 100000,
    6: 150000,
    7: 250000,
    8: 350000
});

const PHASE_ORDER = Object.freeze([
    PHASE.BOOTSTRAP,
    PHASE.EARLY,
    PHASE.BASIC_INFRA,
    PHASE.STORAGE,
    PHASE.LINKS,
    PHASE.TERMINAL,
    PHASE.LABS
]);

const PHASE_RANK = Object.freeze(
    PHASE_ORDER.reduce((acc, phase, idx) => {
        acc[phase] = idx;
        return acc;
    }, {})
);

module.exports = {
    PHASE,
    STATE,
    ORDER_MODE,
    DEFAULT_ORDERS,
    STOCKPILE_STORAGE_ENERGY_TARGET_BY_RCL,
    PHASE_ORDER,
    PHASE_RANK
};
